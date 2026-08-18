# Loops — implementation plan

**Status:** ready for independent review. Nothing built, nothing merged.
**Branch:** `t3code/loop-observation-thread-prototypes`
**Baseline:** fork `main` @ `f6355f06f`, on upstream merge-base `a4cc1367b` (2026-08-17), **zero
commits behind upstream at verification (2026-08-17)**. Every claim below was verified against that tree — see
[UPSTREAM-DELTA.md](UPSTREAM-DELTA.md) §7.

| Companion doc | What it holds |
|---|---|
| [report.html](report.html) | the design report, 8 clickable prototypes embedded |
| [BACKEND.md](BACKEND.md) | full backend design + rejected architectures |
| [TESTS.md](TESTS.md) | 159 test cases |
| [FINDINGS.md](FINDINGS.md) | raw research notes |
| [UPSTREAM-DELTA.md](UPSTREAM-DELTA.md) | the 2026-08-17 re-verification |

---

## How to review this

The plan is written to be challenged. Three things to know:

1. **Claims are marked.** `[V]` = verified by running a command against the tree, with the command
   or file cited. `[A]` = assumed, not yet tested. Every `[A]` is a place the plan could be wrong.
2. **§11 lists what would falsify each major decision.** If you disagree, the fastest route is to
   attack the evidence there rather than the conclusion.
3. **§10 has the open questions.** Four of them are genuinely open and are the highest-value place
   for an outside opinion.

Context a reviewer needs is in §1 — this is a **fork** of an actively-developed upstream, and
"what does this cost at every future rebase" is a first-class constraint that would not exist in a
normal codebase. Several decisions below look over-cautious until that is understood.

---

## 0. Summary

**Build a fork-owned, durable loop supervisor for T3 Coil that lets a thread keep working
unattended, bounds what it may spend, and gives the human a single page answering "what do you need
from me?" when they come back.**

Three properties define it:

- **It backstops, it does not replace.** Claude's own scheduler already paces a session well under
  ~30 minutes `[V]`. T3 defers to it and covers only what an in-process scheduler cannot: wakes over
  an hour, wakes lost to a restart, non-Claude providers, and any notion of a budget.
- **It is durable.** State lives on disk. A restart at 3am loses nothing — which is precisely the
  gap upstream's in-memory liveness tracking leaves open, by its own module doc `[V]`.
- **It collects questions without stopping.** The native `AskUserQuestion` blocks the turn until a
  human answers `[V]`, so one correct question at 01:00 costs the night. A non-blocking
  `raise_blocker` sits beside it, and the console merges both.

**Not** a scheduler for creating threads, not a cron UI, not a replacement for auto-resume.

---

## 1. Context for an independent reviewer

**T3 Coil is a fork of `pingdotgg/t3code`** that rebases onto upstream continuously — 116 upstream
commits landed in the three days before this plan was written, and the sync carrying them landed on
`main` the same day `[V]`. The fork maintains a **seam ledger** (`docs/coil/SEAMS.md`) listing every
upstream-owned file it edits: currently **53 files, +2590/−1042 lines** `[V]`. Each edited file is a
permanent, recurring merge cost.

This produces three rules that shape everything below and would look strange otherwise:

1. **New files are free; edits to upstream files are expensive.** A 500-line new module in
   `apps/server/src/coil/` costs nothing at rebase. A 2-line edit in a hot upstream file costs
   something every single sync, forever.
2. **Prefer additive edits.** The fork maintains an invariant that shared-file edits are `+N/−0`,
   because a deletion means displacing upstream logic and is what makes a zero-conflict rebase
   untrustworthy.
3. **Avoid persisted upstream schemas.** `packages/contracts/src/settings.ts` is a persisted schema
   and a known conflict anchor; fork state goes in fork-owned JSON instead.

**The existing prior art is `apps/server/src/coil/autoResume/`** — a 15-file fork-owned module that
already does the hard parts: a self-starting Effect layer, a durable JSON store with atomic writes,
a reactor that dispatches real turns, and raw HTTP routes that avoid touching the WS-RPC contract.
This plan mirrors it deliberately, file for file, because it is proven in production and its shape
has already survived review.

---

## 2. Decisions already taken

Each with the reasoning, so a reviewer can attack the reasoning rather than guess at it.

| # | Decision | Why | Confidence |
|---|---|---|---|
| D1 | **Durable T3-native reactor, backstopping Claude's scheduler** | Claude's scheduler works ≤30min but is in-process, clamped to 1h, and Claude-only `[V]` | High — evidence in BACKEND §1.1 |
| D2 | **Trigger on `updatedAt` staleness + recorded `session_crons`, never `session.status`** | A background subagent's message auto-opens a synthetic turn that pins `status = running` and nothing closes it — gating on it deadlocks the exact threads this is for `[V]` | High |
| D3 | **A loop is a pinned thread** (Direction A) | Upstream shipped pinning 2026-08-04; `pinnedAt` overrides the settled/snoozed lifecycle; costs zero sidebar edits `[V]` | High |
| D4 | **The Loops workspace (Direction C) is phase 2, not phase 1** | User agreed. Lives in fork-owned routes, so cost is low, but it is only worth it once several loops exist | High — user-confirmed |
| D5 | **Never Direction B** (a bespoke Loops section in the sidebar) | Would open a row in `Sidebar.tsx` (3911 lines, 7 commits in 3 days `[V]`) and `Sidebar.logic.ts`; also has no mobile equivalent | High |
| D6 | **Two question channels: blocking (native) + deferred (`raise_blocker`)** | `AskUserQuestion` blocks on a `Deferred` `[V]`; a loop that waits loses the night, and one that nudges past a pending decision is worse | High |
| D7 | **Console reads three sources, two needing no model cooperation** | Degradation test: a model that never calls `raise_blocker` must still produce a useful console | High |
| D8 | **Budget is check-ins + wall-clock, not dollars** | `total_cost_usd` is unread anywhere in the repo and is documented as session-accumulated, so per-turn summing would inflate quadratically `[A - not measured]` | Medium — revisit if metered |
| D9 | **Mandatory budget, no unlimited option; route returns 400 rather than clamping** | A silent clamp hides a mistake in a feature that spends money unattended | Medium |
| D10 | **Own settings section** (`/settings/loops`) | Now priced at 2 small additive seam rows, with a 3-day-old upstream precedent `[V]` | High |
| D11 | **Fork-owned durable JSON, not a DB migration** | The migration registry is upstream-owned; `autoResume` set this precedent and it has held | High |
| D12 | **Zero `packages/contracts` edits** | Activity `kind` is an open string with an `Unknown` payload, so breadcrumbs are free; and upstream has pre-announced this file as its own automations landing zone | High |

---

## 3. Scope

### In

- A per-thread loop: arm, bound, supervise, stop, re-arm.
- Deference to the agent's own scheduler, via recorded `session_crons`.
- The console: blocking items, deferred blockers, loop state, iteration ledger.
- `raise_blocker` / `loop_status` / `loop_done` as a fork MCP toolkit.
- Settings: master toggle, defaults, armed roster.
- Web + desktop (same app). Mobile read-only surfacing.

### Out (explicitly, with reasons in report §12)

- **Scheduled loop *creation*** ("start this every night at 23:00") — needs a thread-creation
  trigger, a second mechanism; and it is where upstream's own automations work is heading.
- **Reusable loop templates** — worth it only after the same loop has run several times.
- **Dollar-cost budgets** — see D8.
- **Cross-thread loops** — the maintainer loop's work-source abstraction is designed for, but not
  built in, this plan.
- **Loops answering their own low-stakes questions** — destroys the console's completeness, which is
  the only reason to trust it.
- **Maintainer bots (#44)** — the same reactor with a different work source; sequenced after.

### Divergences from #42 (deliberate, and open to challenge)

- **#42 Phase 1d's `CLAUDE_CODE_DISABLE_CRON` per-thread toggle (default off) is dropped.** It was
  specified when the scheduler looked untrustworthy; the correction in §1 inverted that, and the
  user now relies on self-paced wakes — a default-off kill switch would disable the very mechanism
  Phase 1 exists to observe. #42's "50 recurring jobs with no human in the path" concern is real,
  but it is a full-access policy question, not a loops question. If review disagrees, the switch is
  one env line in the same `ClaudeAdapter` row this plan already takes.
- **#42's Experiments B and D were not run.** B (does a cron-fired turn render in the transcript as
  if the human typed it?) needs a real `session_crons` fire to answer — it moves into Phase 1's
  observation checklist rather than blocking the design. D (gate stability under the `sdk-ts` entrypoint) is
  absorbed by designing for the `gate_off` degraded state (BACKEND §4; TESTS case 11h): nothing here
  depends on the gates staying on.
- **#42 Phase 2's `wake_me` tool is not carried over.** The agent already has native long-horizon
  scheduling (`CronCreate` / `ScheduleWakeup`); a fork mirror would be a parallel path to an
  upstream capability. `raise_blocker` covers the one thing the native tools cannot do — hand a
  durable, non-blocking question to a human — and a wake armed-then-lost is exactly what the
  staleness trigger backstops.

---

## 4. Architecture

```
                     ┌──────────────────────────────────────────┐
   Claude binary ───▶│ Stop / SubagentStop hook                 │
   (self-paces)      │   input.session_crons ──▶ coil/loop/crons│──┐
                     └──────────────────────────────────────────┘  │
                                                                   ▼
   SQL projection ──▶ shell.updatedAt ─────────────────▶ ┌──────────────────┐
   (survives restart)                                    │ decide.ts (pure) │
                                                         │  + guards.ts     │
   coil-loop.json ──▶ budget, deadline, strikes ────────▶└────────┬─────────┘
   (durable)                                                      │
                                                                  ▼
                                         skip ◀───────── Decision ────────▶ fire
                                     (spends nothing)                       │
                                                                            ▼
                                                        engine.dispatch(thread.turn.start)
                                                            (an ordinary user turn)
```

**Console sources** — the degradation property is that only the third needs the model:

```
1. hasPendingApprovals / hasPendingUserInput / hasActionableProposedPlan   ← SQL columns
2. loop skip reason, stop reason, budget, ledger                           ← fork store
3. deferred blockers                                                       ← raise_blocker (MCP)
```

Full detail, including the guard table and the check-in prompt, is in **BACKEND.md**.

---

## 5. Phases

Each phase is independently shippable and independently revertible. Estimates are rough and assume
one focused agent-assisted session per unit.

### Phase 0 — fork-owned prep (no behaviour change)

**Goal:** pay down two small debts that this feature would otherwise duplicate.

- Promote the HTTP scope-auth helper into a shared `apps/server/src/coil/http/auth.ts`. Today there
  are **two independent implementations of the same mirror of upstream's private auth path** `[V]`:
  `autoResume/http.ts:45` has `authenticateWithOperateScope` (scope hardcoded) and
  `webPush/http.ts:49` has `authenticateWithScope(scope)` (parameterised). The webPush form is
  strictly more general — promote it, re-point `autoResume`, and let the loop routes be the third
  caller rather than the third paste.
- Widen `isClaudeThread` from `(thread: OrchestrationThread)` to
  `Pick<OrchestrationThread, "session">` so an `OrchestrationThreadShell` is assignable `[A — the
  archived design verified this; re-check]`.

**Files:** `coil/http/auth.ts` (new), `coil/autoResume/http.ts`, `coil/webPush/http.ts`,
`coil/autoResume/guards.ts` — all fork-owned.
**Seam cost:** 0. **Acceptance:** existing suites green, zero behaviour change.
**Size:** S.

---

### Phase 1 — the durable record (no supervision yet)

**Goal:** know what is happening. Ship nothing that acts.

This phase is deliberately inert, and it is the most important one to get right — everything else
reads its state.

- `coil/loop/state.ts` — the durable store (`coil-loop.json`). Every field with a decoding default.
- `coil/loop/crons.ts` — the `Stop` / `SubagentStop` hook callbacks: read `input.session_crons`,
  normalise to `{ id, kind, nextFireAtMs, prompt }`, persist per thread.
- `coil/loop/config.ts` — env-overridable defaults.
- **The one upstream edit:** a single spread into `ClaudeAdapter`'s existing `queryOptions` object,
  beside the `mcpServers` spread:
  ```ts
  ...(loop ? { hooks: loop.claudeHooks(threadId) } : {}),
  ```
- Record `user-input.requested` events fork-side, so a question **voided** by session teardown
  (upstream #5127 `[V]`) is still visible. See UPSTREAM-DELTA §3.1.
- `GET /api/coil/loop?threadId=…` returning the record.

**Seam cost:** **1 new row** — `ClaudeAdapter.ts` `+1`, additive and read-only.
**Acceptance:**
- Arming is impossible (no arm route yet); nothing dispatches.
- On a Claude thread that self-paces, `GET` shows the pending wake with a plausible `nextFireAtMs`.
- On a non-Claude thread, the record exists and `crons` is empty — no errors.
- A hook callback that throws does not break the turn `[V-by-test]`.
- Killing and restarting the server preserves the record.

**Why first:** it is the only phase that can be validated purely by observation, and it de-risks the
one upstream edit before anything depends on it. If the hook surface turns out not to deliver
`session_crons` as documented, **the plan changes here and nothing has been wasted.**
**Size:** M.

---

### Phase 2 — the reactor (the thing that acts)

**Goal:** restart a silent thread, bounded.

- `coil/loop/decide.ts` (pure), `guards.ts` (pure), `sentinel.ts`, `Reactor.ts`.
- Arm / disarm / re-arm via `POST /api/coil/loop`, with the 400s from D9.
- Arming also dispatches `thread.pin`; disarming unpins `[A — verify pin/unpin from a fork reactor]`.
- Rate-limit tap fiber; `rateLimitedUntilMs` persisted.
- Timeline breadcrumbs via `thread.activity.append` with `coil.loop.*` kinds.
- **Default off**, behind the master toggle, behind an env kill switch.

**Seam cost:** 0 new rows (`coil/index.ts` is fork-owned).
**Acceptance:** the TESTS.md integration scenarios, specifically:
- Self-paced healthy: T3 fires **zero** times over 3 simulated hours.
- Self-paced wake lost to a restart: covered exactly once.
- A stall: exactly one fire at the threshold, none during background activity.
- Budget exhaustion reports `spent`, never `done`.
- Human takeover disarms without resetting budget.

**Size:** L. This is the bulk of the work.

---

### Phase 3 — the console

**Goal:** the page you open at 9am.

- `apps/web/src/coil/ThreadCoilOverlay.tsx` — the fork-owned aggregator. **Rewrite the existing
  overlay row in place** so the seam delta is zero `[V — the row is +10/−6, risk 0]`.
- Console UI: blocking / deferred / loop-state sections, iteration ledger, empty state.
- `POST /api/coil/loop/answer`, routing native pending-inputs to the existing resolve path and
  blockers to the fork store.

**Seam cost:** 0 (existing row rewritten, delta unchanged).
**Acceptance:**
- The **empty-state test**: a loop that ended `spent` with a model that never called
  `raise_blocker` still renders a useful console.
- Answering a blocking item resumes the loop.
- A voided question is visibly distinct from an answered one.
**Size:** M.

---

### Phase 4 — settings

**Goal:** the on/off switch and the bounds.

- `apps/web/src/routes/settings.loops.tsx` (new, fork-owned) + a fork-owned panel component.
- `settingsSearch.ts`: `SettingsPath` union + label + 2–3 search items.
- `SettingsSidebarNav.tsx`: icon import + record entry.
- **Not** `SettingsPanels.tsx` (churn 32, risk 1856), **not** `contracts/settings.ts` (persisted).

**Seam cost:** **2 new rows**, ~+6 lines total, both additive.
**Sequencing:** no longer a constraint. This originally had to wait for the sync carrying upstream
#7082, or the `settingsSearch.ts` entry would have conflicted with `integrations` on the way in.
That sync has landed — `routes/settings.integrations.tsx` is in the tree and `settingsSearch.ts`
carries 7 `integrations` references `[V]` — so phase 4 now adds its entry beside a row that is
already there, which was the cheap ordering all along.
**Acceptance:** master toggle off ⇒ no fiber, nothing armed, existing loops stand down at next tick.
**Size:** S–M.

---

### Phase 5 — `raise_blocker` and the deferred channel

**Goal:** stop one question costing a night.

- `apps/server/src/mcp/toolkits/loop/` — `raise_blocker`, `loop_status`, `loop_done`.
- Console renders deferred blockers; answers are delivered on the next check-in prompt.

**Seam cost:** 0–3 rows `[A]` — the toolkit itself is new, but the capability gate may require
edits to `McpInvocationContext.ts` / `McpSessionRegistry.ts` / `McpHttpServer.ts`. **Measure before
committing to this phase** — the archived design estimated three files and that has not been
re-verified.
**Acceptance:**
- `raise_blocker` returns immediately (assert elapsed time, not just the value).
- Attribution comes from `McpInvocationContext`, never from an argument.
- The answer reaches the agent on the next check-in.
**Size:** M.

---

### Phase 6 — the Loops workspace (D4)

Only once several loops exist. Fork-owned routes, a mode switch carrying an unread count, the
cross-loop inbox. **Seam cost:** ~1 row wherever the switch mounts. **Size:** M–L.

---

## 6. Seam budget

The total upstream cost of the whole feature, which is the number that matters for a fork:

| Phase | File | Delta | Kind |
|---|---|---|---|
| 1 | `provider/Layers/ClaudeAdapter.ts` | +1 | **new row** — additive, read-only |
| 3 | `routes/_chat.$environmentId.$threadId.tsx` | ±0 | existing row rewritten in place |
| 4 | `settings/settingsSearch.ts` | ~+4 | **new row** — additive |
| 4 | `settings/SettingsSidebarNav.tsx` | +2 | **new row** — additive |
| 6 | mode-switch mount | ~+2 | **new row** — additive, deferred |
| — | `packages/contracts` | 0 | — |
| — | `Sidebar.tsx` / `Sidebar.logic.ts` | 0 | a loop is a pinned thread |
| — | `server.ts` | 0 | already has its row |

**Total: 3 new rows for phases 1–4** (~7 lines), all additive, plus one deferred. For comparison,
the ledger currently carries 53 rows.

---

## 7. Test strategy

159 cases in TESTS.md, plus the three coverage gates in its §11. Structure:

- **Pure and fast** — `decide.ts` and `guards.ts` are pure so the entire decision table tests
  without a server or clock. Target **100% branch coverage** on both.
- **Property-ish invariants** rather than only examples: one table-driven case asserting *every*
  skip guard leaves the budget unchanged, so a future guard added without that property fails.
- **A schema-reflective test** that fails if a field is added to the record without a decoding
  default — that omission silently disarms every loop on the machine.

The four to write first:

1. Self-paced healthy ⇒ T3 fires zero times. *(the "does not fight the agent" regression)*
2. Self-paced wake lost to a restart ⇒ covered exactly once. *(the durability gap, as a test)*
3. The empty console. *(the degradation property)*
4. `spent` is never reported as `done`.

---

## 8. Rollout

- **Default off** at every level: env kill switch, master setting, per-thread arm.
- **Dogfood** on this repo's own overnight runs before anything else.
- **Kill path:** `COIL_LOOP_ENABLED=0` stops the fiber forking at layer construction. The master
  toggle is re-read every tick *and* immediately pre-dispatch, so it is a true kill switch rather
  than one-tick-stale.
- **Blast radius if wrong:** bounded by the mandatory budget (≤20 check-ins/loop) and the armed-loop
  ceiling (default 3). Worst case is `3 × 20 = 60` unwanted turns, and the reserve-before-dispatch
  discipline means a broken provider burns budget rather than tight-looping.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `session_crons` is not delivered as the SDK types document | Medium `[A]` | Phase 1 invalid | **Phase 1 is designed to find this out cheaply.** Fallback is pure staleness with a longer threshold — worse, but zero upstream cost |
| Upstream ships its own automations feature | Medium | Duplicated work | Zero contracts edits means the fork becomes a *caller*, not a migration. Re-check each sync |
| The `ClaudeAdapter` row conflicts on a sync | Low-Medium | Recurring cost | One additive line beside an existing spread; fails to a type error, not silent drift |
| A loop pushes past a human decision | Low | Trust | Three separate guards (approvals, pending input, plan-ready), each non-consuming |
| Token burn from a runaway loop | Low | Cost | Mandatory budget, deadline, armed ceiling, reserve-before-dispatch, strike detector |
| Model never calls `raise_blocker` | **High** | Console thinner | By design: two of three console sources need no model cooperation. This is the acceptance test |
| `spent` misread as success | Medium | The original problem returns | Distinct colour, distinct word, distinct push copy; asserted in tests |
| `settingsSearch.ts` conflicts | Medium `[V — 3 commits/3 days]` | Small recurring | Append-ordered array, same add/add shape as #29. The #7082 ordering is already satisfied; the residual risk is ordinary and priced |

---

## 10. Open questions for review

The four places an outside opinion is most valuable.

**Q1 — Is the deference rule right, or too clever?**
T3 stands down when the agent has a wake pending. The alternative is that T3 always paces on its own
clock and simply tolerates occasional double-firing. Deference is more correct and more complex, and
it makes the feature's behaviour depend on a hook whose delivery is `[A]`. *Is the complexity worth
it, or should v1 pace unconditionally with a long threshold?*

**Q2 — Should the console be loop-only, or a global inbox from day one?**
Prototype P7 shape C makes it a cross-thread "needs you" surface. It is barely more work, it is
useful with loops switched off, and it might be the more valuable feature. *Is the loop the right
container for this at all?*

**Q3 — Is `raise_blocker` worth the MCP toolkit, or should it be a file?**
A blocker could be a line the agent appends to `.coil/blockers.jsonl`, read by the same read-only
supervisor that stats the done-file. That is provider-agnostic with **zero** MCP work, at the cost
of no structured options and no immediate confirmation to the agent. *Cheaper and worse, or cheaper
and sufficient?*

**Q4 — Is the budget model right?**
Check-ins + wall-clock, deliberately not dollars (D8, based on an unverified reading of
`total_cost_usd` `[A]`). *Should someone measure that field first, and would a dollar cap change the
design?*

---

## 11. What would falsify this plan

Stated so a reviewer can aim at evidence rather than opinion.

| If this turned out to be true | Then |
|---|---|
| `session_crons` is empty/absent in practice on real Claude sessions | Deference is unbuildable; fall back to pure staleness; the `ClaudeAdapter` row is not worth taking |
| `cron_durable` flips to **true** upstream | Claude's crons survive restarts; the durability argument weakens sharply and this feature shrinks to bounds + console |
| Upstream ships a supervision/automations feature | Re-cut against it. The console and the question channel probably survive; the reactor probably does not |
| `AskUserQuestion` becomes non-blocking | D6 collapses — one channel suffices, and `raise_blocker` is unnecessary |
| The user's real loops are almost never blocked on questions | The console is over-built; ship the reactor and the status pill only |
| Pinning is removed or reworked upstream | D3 collapses back to the Direction A/B/C comparison, and C becomes the answer |

---

## 12. Immediate next actions

1. **Review this plan** (that is what it is for).
2. Decide Q1–Q4.
3. Open a consolidated issue; close #42 pointing at it; note the residue of #38 is now covered.
4. Start **Phase 0** — it is pure debt paydown, zero seam, and safe to do before any decision lands.
5. Start **Phase 1** — it answers the biggest `[A]` in the plan at the cost of one additive line.
6. When the design is accepted, register its vocabulary (loop, check-in, blocker, deference,
   held / spent / stalled, iteration ledger) in `docs/coil/CONTEXT.md` — created lazily then, per
   `docs/coil/agents/domain.md`, not before.
