# Loops — implementation plan

**Status:** phases 0–2 are built on `coil/loops-backend` — the durable record, the Claude hooks,
the pure decision table, the sentinel, the HTTP surface and the supervisor. Phases 3–5 (the console,
the settings section, the deferred question channel) remain proposed.
**Reviewed and re-baselined 2026-09-02** against the findings in issue #125; §12 lists what changed.
**Baseline:** upstream merge-base **`941acb4f9`** (the 2026-09-02 sync). The merge-base is the
anchor rather than a fork `main` SHA, because every sync rewrites `main`. The package has now moved
base three times — `a4cc1367b` → `cebac353d` → `941acb4f9` — and **every churn and risk figure below
is re-measured against `941acb4f9`**. Several moved materially: `ClaudeAdapter.ts` 16 → **23**,
`settingsSearch.ts` 14 → **24**, `_chat.$environmentId.$threadId.tsx` 4 → **2**. Churn is counted
over the 60 days _before_ the merge-base, so a busier upstream window moves every number without any
fork change. Structural claims were re-verified against that tree — see
[UPSTREAM-DELTA.md](UPSTREAM-DELTA.md) §7 and §9.

| Companion doc                          | What it holds                                        |
| -------------------------------------- | ---------------------------------------------------- |
| [report.html](report.html)             | the design report, 8 clickable prototypes embedded   |
| [report.src.html](report.src.html)     | the source the report is built from — edit this one  |
| [BACKEND.md](BACKEND.md)               | full backend design + rejected architectures         |
| [TESTS.md](TESTS.md)                   | 183 test cases                                       |
| [FINDINGS.md](FINDINGS.md)             | raw research notes                                   |
| [UPSTREAM-DELTA.md](UPSTREAM-DELTA.md) | the 2026-08-17 re-verification, plus §9 (2026-09-02) |

`report.html` is generated. Edit `report.src.html` (or a prototype under `prototypes/`), then run
both steps — `node docs/coil/loops-v2/build-report.mjs` and
`vp fmt docs/coil/loops-v2/report.html` — because the committed file is formatted output and
building alone rewrites its whitespace.

---

## How to review this

The plan is written to be challenged. Three things to know:

1. **Claims are marked.** `[V]` = verified by running a command against the tree, with the command
   or file cited. `[V - external]` = verified by command too, but against a shipped dependency —
   the Claude binary or the agent SDK's type declarations — rather than against this tree, so it
   can move without any repo diff to warn us. `[A]` = assumed, not yet tested. Every `[A]` is a
   place the plan could be wrong.
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
  ~30 minutes `[V]`, and `CronCreate` can arm a wake arbitrarily far out `[V - external]`. T3 defers
  to it and covers only what an in-process scheduler cannot: wakes lost to a restart, non-Claude
  providers, and any notion of a budget.
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
upstream-owned file it edits: currently **53 files, +2609/−981 lines** `[V]`. Each edited file is a
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

| #   | Decision                                                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Confidence                      |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| D1  | **Durable T3-native reactor, backstopping Claude's scheduler**                          | Claude's scheduler works ≤30min but is in-process and Claude-only `[V]`. Only `ScheduleWakeup` is clamped, to [60, 3600]s; `CronCreate` takes an unbounded cron expression and both write `session_crons` `[V - external]`                                                                                                                                                                                                                                                                                                                                                                           | High — evidence in BACKEND §1.1 |
| D2  | **Trigger on `updatedAt` staleness + recorded `session_crons`, never `session.status`** | `ProviderSessionReaper` skips any binding whose thread has `session.activeTurnId != null` `[V]`, so a turn whose completion never arrives pins `status = running` with nothing automated to clear it — gating on it deadlocks the exact threads this is for. **"Never" is scoped, not absolute**: `status ∈ {running, starting}` is read as `busyTurn`, which selects `busyIdleMs` (45 min) over `idleMs` (15 min). It **lengthens the fuse and never vetoes a fire** — that distinction is the long-tool-call case, and a reader who takes "never `session.status`" literally drops it (BACKEND §4) | High                            |
| D3  | **A loop is a pinned thread** (Direction A)                                             | Upstream shipped pinning 2026-08-04 and it still costs **zero** sidebar edits `[V]`. **What a pin buys has shrunk twice and the decision survives both** — see the note below the table                                                                                                                                                                                                                                                                                                                                                                                                              | Medium-High — see the note      |
| D4  | **The Loops workspace (Direction C) is a later phase (Phase 6), not phase 1**           | User agreed. Lives in fork-owned routes, so cost is low, but it is only worth it once several loops exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | High — user-confirmed           |
| D5  | **Never Direction B** (a bespoke Loops section in the sidebar)                          | Would open a row in `Sidebar.tsx` (3911 lines, 7 commits in 3 days `[V]`) and `Sidebar.logic.ts`; also has no mobile equivalent                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | High                            |
| D6  | **Two question channels: blocking (native) + deferred (`raise_blocker`)**               | `AskUserQuestion` blocks on a `Deferred` `[V]`; a loop that waits loses the night, and one that nudges past a pending decision is worse                                                                                                                                                                                                                                                                                                                                                                                                                                                              | High                            |
| D7  | **Console reads three sources, two needing no model cooperation**                       | Degradation test: a model that never calls `raise_blocker` must still produce a useful console                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | High                            |
| D8  | **Budget is check-ins + wall-clock, not dollars**                                       | The adapter stamps `total_cost_usd` onto `turn.completed.totalCostUsd` and nothing downstream aggregates it; its per-turn vs session-accumulated semantics are unmeasured `[A]`, so summing per turn could inflate quadratically                                                                                                                                                                                                                                                                                                                                                                     | Medium — revisit if metered     |
| D9  | **Mandatory budget, no unlimited option; route returns 400 rather than clamping**       | A silent clamp hides a mistake in a feature that spends money unattended                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Medium                          |
| D10 | **Own settings section** (`/settings/loops`)                                            | Now priced at 2 small additive seam rows, with an upstream precedent that landed the same day (2026-08-17) `[V]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | High                            |
| D11 | **Fork-owned durable JSON, not a DB migration**                                         | The migration registry is upstream-owned; `autoResume` set this precedent and it has held                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | High                            |
| D12 | **Zero `packages/contracts` edits**                                                     | Activity `kind` is an open string with an `Unknown` payload, so breadcrumbs are free; and upstream has pre-announced this file as its own automations landing zone                                                                                                                                                                                                                                                                                                                                                                                                                                   | High                            |

**Correction on D3, added by the #125 review.** Two facts moved under it and neither kills it.

_First, upstream inverted pin-vs-settle._ `f70eeeeb0` (#7969, 2026-08-23) rewrote the contract
comment to _"Settled and snoozed threads remain in their respective shelves even when pinned"_, and
the sidebar's partition is now a single `if/else if` chain — snoozed, then settled, then pinned,
then active `[V]`, mirrored verbatim in `apps/mobile/src/features/threads/threadListV2.ts`. So the
old claim that "`pinnedAt` overrides auto-settle" is **false**: a settled loop leaves the pinned
block. What survives is that a pinned thread still shows its pin marker in whichever shelf it lands
in, and that the whole arrangement costs zero fork lines.

_Second, and more usefully, `thread.pin` turns out to be a promotion rather than a decoration._ Its
decider case emits companion `thread.unsettled` and `thread.unsnoozed` events, with a comment
saying so `[V]`. That mostly makes the inversion moot for a loop — arming pins, and pinning
unsettles — but it also means arming a **snoozed** thread would silently cancel the snooze, and
disarming would remove a pin the user set themselves. BACKEND §7 now carries the three rules that
follow (`400 thread_snoozed` on arm, unsettle-on-arm is correct, `pinnedByLoop` gates the unpin).

_The decision stands_ because its actual load-bearing claim was never "pinning keeps a loop
visible forever" — it was **"Direction A costs zero rows in `Sidebar.tsx`"**, and that is unchanged.
Confidence drops from High to Medium-High because the visibility a pin buys is now conditional.

**Retraction on D2, added by review.** The justification previously read "a background subagent's
message auto-opens a synthetic turn that pins `status = running` and nothing closes it", marked
`[V]`. Both halves were wrong. A subagent's message opens nothing: upstream #5219 (`a2ca89aa1`,
2026-08-06) returns early for any assistant snapshot carrying `parent_tool_use_id`, and that is the
only site that creates a synthetic turn. And four closers exist, one of them unconditional —
`handleResultMessage` ends in a bare `completeTurn`, which writes `status: "ready"`. What survives
is the reaper: it will not reap a binding whose thread has an open turn, so a **top-level** assistant
message arriving with no active turn opens a synthetic turn that only a later SDK `result`, the
user's next message, or process exit will close. That is enough to deadlock a `status` gate, and it
is why deference is observable at all — the wake's own `result` is what closes the turn it opened.
The `updatedAt` half of the trigger is independently verified and unchanged.

---

## 3. Scope

### In

- A per-thread loop: arm, bound, supervise, stop, re-arm.
- Deference to the agent's own scheduler, via recorded `session_crons` — **bounded by the loop's own
  wall-clock deadline**, which is mandatory at arm time (Q1, resolved).
- The console: blocking items, deferred blockers, loop state, iteration ledger.
- `raise_blocker` / `loop_status` / `loop_done` as a fork MCP toolkit.
- Settings: master toggle, defaults, armed roster.
- Web + desktop (same app). Mobile read-only surfacing — **deferred until after Phase 3** and
  priced when it is built; this plan takes no mobile seam row.
- The master toggle's **data model and routes** (`LoopGlobalSettings`, `GET`/`POST
/api/coil/loop/settings`) ship in **Phase 2**, with the reactor. Phase 4 adds the UI over them.

### Out (explicitly, with reasons in report §12)

- **Scheduled loop _creation_** ("start this every night at 23:00") — needs a thread-creation
  trigger, a second mechanism; and it is where upstream's own automations work is heading.
- **Reusable loop templates** — worth it only after the same loop has run several times.
- **Dollar-cost budgets** — see D8.
- **Cross-thread loops** — the maintainer loop's work-source abstraction is designed for, but not
  built in, this plan.
- **Loops answering their own low-stakes questions** — destroys the console's completeness, which is
  the only reason to trust it.
- **Maintainer bots (#44)** — the same reactor with a different work source; sequenced after.
- **Push notifications and mobile surfacing.** Designed in the report (§6) and named as a
  requirement in prototype P8, but they have **no phase, no seam line, no acceptance criteria and no
  tests**, and this revision does not invent them (issue #125 §B8, §B9). Two specific things move
  from "designed" to "not built": the three push reasons, and the budget on the mobile thread-list
  row. The latter is not free the way P8 implies — chrome on the mobile row is a **mobile seam row**,
  in a file the fork does not touch today. Price both when mobile is built.

### Vocabulary

Kept here, and **not** in `docs/internals/glossary.md`. That file is upstream-owned and the fork
does not touch it today, so adding four terms would open a **new seam row** for prose — against the
tripwire in `docs/coil/SEAMS.md`, and for a feature whose whole budget is four rows. Move it to
`docs/coil/CONTEXT.md` when that file is created (§12.6); move it upstream only if the feature is
ever upstreamed.

- **Loop** — a bounded, durable supervision record on one thread: a goal, a check-in budget, a
  wall-clock deadline, and the ledger of what happened. Armed by a human, never implicitly.
- **Check-in** — one nudge the loop sends a quiet thread, spending one unit of the budget. Firing
  is the exception; standing down is the normal tick.
- **Stand down** — a tick that did nothing and spent nothing, with a reason. Distinct from a stop:
  the loop stays armed and keeps its bounds.
- **Blocker** — a question the agent raised through `raise_blocker` _without_ stopping, answered
  asynchronously and restated to the agent on the next check-in. Distinct from a native
  `AskUserQuestion`, which blocks the turn.
- **Deference** — standing down because the agent has a wake of its own pending inside the run's
  deadline. The loop covers that wake only if it never lands.
- **Spent** — a run that ended on its budget or its deadline. **Never rendered as success**: the
  agent never signalled done.
- **Iteration ledger** — the per-check-in rows, built from observed facts (cursors, timestamps,
  outcomes) and never from a model-authored summary of its own run.

### Divergences from #42 and #38 (deliberate, and open to challenge)

- **#42 Phase 1d's `CLAUDE_CODE_DISABLE_CRON` per-thread toggle (default off) is dropped.** It was
  specified when the scheduler looked untrustworthy; the correction in BACKEND §1.1 inverted that, and the
  user now relies on self-paced wakes — a default-off kill switch would disable the very mechanism
  Phase 1 exists to observe. #42's "50 recurring jobs with no human in the path" concern is real,
  but it is a full-access policy question, not a loops question. If review disagrees, the switch is
  one env line in the same `ClaudeAdapter` row this plan already takes.
- **None of #42's Phase 0 experiments A–D were run.** A (does a cron-fired turn reach T3 at all?)
  and C (does the reaper win the race?) are cheap, and they fold into Phase 1's observation
  checklist, which is exactly what Phase 1 is for — the record it writes answers both by watching a
  real session rather than by staging one. B (does a cron-fired turn render in the transcript as if
  the human typed it?) also needs a real `session_crons` fire, so it rides along with A and C. D
  (gate stability under the `sdk-ts` entrypoint) is absorbed by designing for the `gate_off`
  degraded state (BACKEND §4; TESTS case 11h): nothing here depends on the gates staying on. The
  design does not claim these results; it claims Phase 1 is the cheapest way to get them.
- **#42 Phase 2's `wake_me` tool is not carried over.** The agent already has native long-horizon
  scheduling (`CronCreate` / `ScheduleWakeup`); a fork mirror would be a parallel path to an
  upstream capability. `raise_blocker` covers the one thing the native tools cannot do — hand a
  durable, non-blocking question to a human — and a wake armed-then-lost is exactly what the
  staleness trigger backstops.
- **The sentinel file stays the primary "done" contract**, inverting #42's reasoning for replacing
  it with a `loop_stop` tool. #42's objection was cwd ambiguity; statting the worktree first
  mitigates that, and a file works from a plain terminal with no MCP at all, which a tool cannot.
  `loop_done` exists beside it, not instead of it.
- **#42's `thread_note` tool is dropped.** Timeline breadcrumbs are reactor-authored
  (`thread.activity.append` with `coil.loop.*` kinds), so the model does not need a tool to write
  them and the console does not depend on the model to have called one.
- **#38's guard #15 — "no open tasks in the roster" as a veto on firing — is not built.** BACKEND
  refuses it: `shell.backgroundLiveness` is in-memory, so after a restart the roster is empty and a
  veto would read "no open tasks" at exactly the moment supervision matters most. Open background
  work may **lengthen** the wait; it may never veto the fire. #38's companion ask — surfacing an
  open-task count in the status pill — is not carried either, and for the same reason: a count that
  is silently zero after a restart is worse than no count at all.
- **#38's run digest is not built as specified.** #38 asked that opening a supervised thread land on
  a digest rather than the raw transcript, with a sticky "Open live chat" toggle, a "right now" block
  naming open subagents, a per-check-in rollup, and the last three assistant messages collapsed. The
  console covers the parts that need no model cooperation: the per-check-in rollup (the iteration
  ledger), loop state and bounds, blocking items, deferred blockers. It deliberately does **not**
  take over the thread route — the transcript stays the default view and the console is an overlay
  on the same route, so there is nothing to toggle back from. **This is a declared divergence from a
  requirement the user stated, not an oversight** — see the note closing this section. And it
  deliberately carries no
  model-authored summary of the run: the ledger renders derived facts, never the model's account of
  its own night, which is the thing that was untrustworthy to begin with. The "right now" block is
  the one part worth reconsidering, and it depends on the same in-memory roster that guard #15 does.
- **`loop_status` is narrower than #38 asked.** #38 wanted the digest available as _data_, so a
  second thread could ask how a run is going. `loop_status` returns the loop's own budget readout to
  the agent inside the loop, and nothing else. Cross-thread reads are a Phase 6 concern (the
  cross-loop inbox); until then the answer to "how is it going" is the console, opened by a human.

**Declared divergence — the console does not become the default view (issue #125 §A2).** The user's
own words were _"at any time I open the chat there should be a page where I have a questionnaire
ready to be answered"_ (FINDINGS §F1), and prototype P7's Shape A — the recommended shape — draws
exactly that: opening a loop lands on the console, transcript one click away. **This plan decides
the opposite, and the reversal is deliberate.** Three reasons, in order of weight:

1. **A second route to toggle back from is a one-way door with a hinge on it.** The fork's own rule
   is that if you add a way in you add the way out and the way to see it. A sticky per-thread view
   toggle is a small piece of state with a large surface: it has to survive reload, agree across
   two windows, agree on mobile, and be discoverable when it is wrong. The overlay has none of that
   — it is additive chrome over a view that already works everywhere.
2. **The seam is genuinely zero, and Shape A's is not.** The overlay rewrites a row the fork already
   owns at delta zero (§6). Landing on a different default view means owning the thread route's
   render decision, which is `ChatView.tsx` territory — an existing row at churn 83.
3. **The requirement is about content, not placement.** What was asked for is a standing answer to
   "what do you need from me?". An overlay that opens on top of the transcript, on the same route,
   with the same content, answers it. Nothing in the ask requires the transcript to go away.

**What is given up, stated plainly:** the console is one interaction away rather than zero, so a
human who opens the thread still sees the night's tail first. If dogfooding shows that tail is what
sends people back to typing "are you still working on it?", Shape A is the fallback and P7 prices
it. FINDINGS §F1 and P7's Shape A now both carry this note; they previously read as the decision.

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
  `autoResume/http.ts` has `authenticateWithOperateScope` (scope hardcoded) and `webPush/http.ts`
  has `authenticateWithScope(scope)` (parameterised). Let the loop routes be the third caller rather
  than the third paste.
  **The webPush form is not simply the better one — promote the union of both.** It is
  parameterised and returns the session, which `autoResume`'s is not; but it calls
  `failEnvironmentAuthInvalid` with one argument where `autoResume`'s passes
  `EnvironmentAuth.serverAuthDpopFailureReason(error)` as the second. That second argument is
  `3bdf109e2` (2026-09-02), which exists because the stale one-argument call compiled and drifted
  silently. Promoting webPush's body verbatim would re-introduce that bug in a shared helper, for
  all three callers. The promoted helper is: parameterised on scope, returns the session, **and**
  passes the DPoP failure reason.
- Widen `isClaudeThread` from `(thread: OrchestrationThread)` to
  `Pick<OrchestrationThread, "session">` so an `OrchestrationThreadShell` is assignable `[V]`. The
  two structs declare the field identically — `session: Schema.NullOr(OrchestrationSession)` in
  both, so both resolve to `OrchestrationSession | null`. Reproduce with
  `git grep -n "session: Schema.NullOr(OrchestrationSession)" packages/contracts/src/orchestration.ts`
  (two hits, one per struct). `Pick<…, "session">` is the minimal shape; nothing else in the
  predicate is read. Note the shells are **not** interchangeable in general —
  `OrchestrationThreadShell` has no `deletedAt`, so guard 4 on a shell tests `archivedAt` plus the
  shell simply being absent.

**Files:** `coil/http/auth.ts` (new), `coil/autoResume/http.ts`, `coil/webPush/http.ts`,
`coil/autoResume/guards.ts` — all fork-owned.
**Seam cost:** 0. **Acceptance:** existing suites green, zero behaviour change.
**Ships as its own PR** — this is unrelated debt the feature merely surfaced, and one concern per PR.
Phase 1 depends on nothing in it.
**Size:** S.

---

### Phase 1 — the durable record (no supervision yet)

**Goal:** know what is happening. Ship nothing that acts.

This phase is deliberately inert, and it is the most important one to get right — everything else
reads its state.

- `coil/loop/state.ts` — the durable store (`coil-loop.json`). Every field with a decoding default.
- `coil/loop/crons.ts` — the `Stop` / `SubagentStop` hook callbacks: read `input.session_crons`
  (`{ id, schedule, recurring, prompt }` — `schedule` is a cron expression, not a timestamp, and
  `prompt` is **truncated to 1000 characters by the binary** `[V - external]`, so nothing here may
  assume it holds the agent's full prompt), compute `nextFireAtMs` fork-side from `schedule`
  (one-shot = single fire time encoded in the fields; server-local tz) `[A — the parse is ours]`,
  persist per thread. **The parse brings no dependency**: there is no cron parser anywhere in this
  repo (`git grep -i cron -- '*package.json'` and a `cron` search over `pnpm-lock.yaml` are both
  empty `[V]`), and none is added. `CronCreateInput.cron` is documented as _"Standard 5-field cron
  expression in local time"_ with `*/5` steps and `1-5` ranges — no seconds field, no macros
  `[V - external]` — so `crons.ts` parses exactly that grammar in ~120 lines. An entry that does not
  parse yields `nextFireAtMs: null`, which means **no deference from that entry**.
- `coil/loop/config.ts` — env-overridable defaults (`COIL_LOOP_*`).
- A `PostToolUse` hook matched on `ScheduleWakeup`, in the **same** fork-built hooks object, to
  source the `gate_off` degraded state. Zero extra seam. The plumbing is verified —
  `HookCallbackMatcher.matcher` selects by tool name and `PostToolUseHookInput` carries
  `tool_name` + `tool_response` `[V - external]` — the response body is not, so it is a substring
  probe rather than a parse (BACKEND §4).
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
- On a non-Claude thread, the record exists and `crons` is `null` — no errors, and no hooks object
  is built at all.
- A hook callback that throws does not break the turn `[A — to be proven by the §4b hook-failure
case]`. The callback returns `{ continue: true }` on every path and never rethrows; a `Stop` hook
  **can** halt a turn by returning `{ decision: "block" }` or `{ continue: false }` `[V - external]`,
  so "observability only" is a property the code has to hold, not one the surface gives for free.
- Killing and restarting the server preserves the record.

**Why first:** it is the only phase that can be validated purely by observation, and it de-risks the
one upstream edit before anything depends on it. Delivery is no longer the open question — the
binary spreads `{ background_tasks, session_crons }` unconditionally into both the `Stop` and
`SubagentStop` hook inputs, and `session_crons` is `[]` rather than absent when a session has no
crons `[V - external]`. What Phase 1 still answers is the **parse**: whether our reading of
`schedule` produces a fire time matching what actually fires. If it does not, **the plan changes
here and nothing has been wasted.**
**Size:** M.

---

### Phase 2 — the reactor (the thing that acts)

**Goal:** restart a silent thread, bounded.

- `coil/loop/decide.ts` (pure), `guards.ts` (pure), `sentinel.ts`, `Reactor.ts`.
- **Deference is bounded by the loop's own wall-clock deadline** (added by review): T3 stands down
  only while the recorded next fire is at or before the deadline. `CronCreate` takes an unbounded
  expression, so an unbounded rule would let a recorded `0 9 * * *` stand T3 down for a day and a
  one-shot pinned to a future date stand it down indefinitely. Past the deadline there is nothing
  left to defer _to_, so the deadline is the natural cap and no new knob is needed. See Q1.
- Arm / disarm / re-arm via `POST /api/coil/loop`, with the 400s from D9 — including
  `400 deadline_required`, because `deadlineAtMs` is mandatory and is not nullable (BACKEND §3).
- **The master toggle's data model and its routes** — `LoopGlobalSettings` in the store, plus
  `GET`/`POST /api/coil/loop/settings`. Moved here from phase 4 by the #125 review: shipping
  "default off behind the master toggle" in phase 2 while only phase 4 could flip it left phases 2
  and 3 **unswitchable as ordered**.
- Arming also dispatches `thread.pin`; disarming unpins **only when the loop created the pin**
  (`pinnedByLoop`). There is no actor check on `thread.pin` — commands carry no actor and the
  decider guards on archival alone `[V]` — so the rules are the fork's to keep. `thread.pin` also
  emits companion `thread.unsettled` / `thread.unsnoozed` events `[V]`, so the arm route returns
  `400 thread_snoozed` rather than silently cancelling a snooze. BACKEND §7.
- Rate-limit tap fiber; `rateLimitedUntilMs` persisted.
- Terminal states and disarm stop the session when recorded crons are still pending
  (`providerService.stopSession` — BACKEND §7), so a bound can actually stop a self-paced run.
- Timeline breadcrumbs via `thread.activity.append` with `coil.loop.*` kinds.
- **Default off**, behind the master toggle, behind an env kill switch.

**Seam cost:** 0 new rows (`coil/index.ts` is fork-owned).
**Acceptance:** the TESTS.md integration scenarios, specifically:

- Self-paced healthy: T3 fires **zero** times over 3 simulated hours.
- Self-paced wake lost to a restart: covered exactly once.
- A stall: exactly one fire at the threshold, none during background activity.
- Budget exhaustion reports `spent`, never `done`.
- Human takeover disarms without resetting budget.
- The master toggle is flippable over HTTP in this phase, with no UI — and flipping it off leaves
  every loop **armed** and reporting `standing_down`, disarming nothing.
- A deadline that has passed stops the loop **even while the thread is busy** (guard 4b), which is
  what stops a self-paced run walking through its own deadline.

**Size:** L. This is the bulk of the work.

---

### Phase 3 — the console

**Goal:** the page you open at 9am.

- `apps/web/src/coil/ThreadCoilOverlay.tsx` (new) — a fork-owned aggregator that mounts
  `AutoResumeOverlay` and the console; then **rewrite the existing overlay row in place** to mount
  it, so the seam delta is zero `[V — re-measured 2026-09-02: the row is +10/−6, churn **2**, risk
**32**; the edit swaps one JSX element for one JSX element inside the fragment the fork already
added, so the delta is unchanged]`. The fork's web client pattern to reuse is
  `AutoResumeOverlay.tsx`: `ManagedRuntime.make(primaryEnvironmentHttpLayer)` +
  `resolvePrimaryEnvironmentHttpUrl`, 30s poll plus a focus listener, every failure swallowed to
  `null` so the overlay disappears rather than degrading chat. Auth is ambient (the environment HTTP
  layer attaches the credential); **there is no client-side scope check and none should be added** —
  the 403 is the server's to state.
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
- `settingsSearch.ts`: `SettingsPath` union + `SETTINGS_SECTION_LABELS` entry + 2
  `SETTINGS_SEARCH_ITEMS` — **~+13 lines**, because each search item is a 5–6 line object literal in
  the file's existing style. A third search item takes it to ~+19.
- `SettingsSidebarNav.tsx`: icon import + `SETTINGS_SECTION_ICONS` entry — +2.
- **Both rows are mandatory, not stylistic** `[V]`: `SETTINGS_SECTION_LABELS` and
  `SETTINGS_SECTION_ICONS` are both `Readonly<Record<SettingsPath, …>>` and `SETTINGS_NAV_ITEMS` is
  derived from the label record's keys, so adding a `SettingsPath` member without both entries is a
  type error.
- **Not** `SettingsPanels.tsx` (churn **43**, risk ~2900), **not** `contracts/settings.ts`
  (churn **38**, persisted). Loop state stays in `coil-loop.json`; the panel reads and writes
  `/api/coil/loop/settings`, which phase 2 already shipped.

**Seam cost:** **2 new rows**, ~+15 lines total, both additive. **Re-measured 2026-09-02 and the
price has risen**: `settingsSearch.ts` is now churn **24** (was 14) and `SettingsSidebarNav.tsx`
churn **19**, so risk is ~312 and ~38. D10 stands, but this is now the most expensive phase in the
plan by risk, and it buys discoverability rather than function. **The zero-row fallback, if the rows
are ever refused:** `/settings/diagnostics` is a real settings route that is **not** a `SettingsPath`
member — its label is patched in by `SETTINGS_BREADCRUMB_LABELS` `[V]` — so a fork route reached
from the console costs zero rows and loses only nav and search discoverability.
**Sequencing:** no longer a constraint. This originally had to wait for the sync carrying upstream
#7082, or the `settingsSearch.ts` entry would have conflicted with `integrations` on the way in.
That sync has landed — `routes/settings.integrations.tsx` is in the tree and `settingsSearch.ts`
carries 7 `integrations` references `[V]` — so phase 4 now adds its entry beside a row that is
already there, which was the cheap ordering all along.
**Acceptance:** the toggle is a **guard, not a lifecycle** (issue #125 §A3). The supervisor fiber
always runs — one tick loop, like auto-resume — and the toggle is re-read every tick and again
pre-dispatch. Toggle off ⇒ nothing fires, every armed loop reports `standing_down` with reason
`disabled`, **nothing is disarmed and nothing is stopped**; toggle back on and the same loops resume
with budgets intact. The only thing that stops a fiber existing is `COIL_LOOP_ENABLED=0`, read once
at layer construction. An earlier draft of this line said "no fiber" **and** "stand down at next
tick", which cannot both be true — a tick requires a fiber.
**Size:** S–M.

---

### Phase 5 — `raise_blocker` and the deferred channel

**Goal:** stop one question costing a night.

- `apps/server/src/mcp/toolkits/loop/` — `raise_blocker`, `loop_status`, `loop_done`.
- Console renders deferred blockers; answers are delivered on the next check-in prompt.

**Seam cost: 1 new row — `McpHttpServer.ts` `+2/−1`, churn 2, risk 6.** Measured 2026-09-02, no
longer `[A]`. The measurement changed the design: the archived estimate of three files assumed a
gated `"loop"` capability, and that path is now **rejected** — `McpCapability` is backed by a runtime
`Schema.Literal("preview")` in `packages/contracts/src/previewAutomation.ts`, so widening it is a
**contracts edit** and breaks D12, and it would make `raise_blocker` fail with an error class named
`PreviewAutomationUnavailableError`. It buys nothing in exchange: nothing at registration or
dispatch consults `capabilities`, and the MCP credential is already per-thread and already
all-or-nothing `[V]`. The toolkit's real gate is `store.global.enabled` plus the per-thread armed
record. A **zero-row** path exists (register the toolkit from `coil/index.ts`, using upstream's own
`Effect.withFiber` + `Context.getUnsafe` shape to keep the layer's `R` empty); it is worth one
focused attempt and is **not typechecked**, so budget the one row and treat zero as upside.
**Inherited coupling:** the MCP credential is minted only when `enableAgentBrowserAccess` is true
`[V]`, so turning off **Settings → Integrations → Agent browser access** silently removes all three
tools. The console must name that state rather than render an empty blocker list.
**Acceptance:**

- `raise_blocker` returns immediately (assert elapsed time, not just the value).
- Attribution comes from `McpInvocationContext`, never from an argument.
- The answer reaches the agent on the next check-in.
- With `enableAgentBrowserAccess` off, the console says so by name.
  **Size:** M.

---

### Phase 6 — the Loops workspace (D4)

Only once several loops exist. Fork-owned routes, a mode switch carrying an unread count, the
cross-loop inbox. **Seam cost:** ~1 row wherever the switch mounts. **Size:** M–L.

---

## 6. Seam budget

The total upstream cost of the whole feature, which is the number that matters for a fork.
All churn and risk re-measured against merge-base `941acb4f9`, 2026-09-02.

| Phase | File                                        | Delta | Churn | Risk | Kind                                     |
| ----- | ------------------------------------------- | ----- | ----- | ---- | ---------------------------------------- |
| 1     | `provider/Layers/ClaudeAdapter.ts`          | +1    | 23    | 23   | **new row** — additive, read-only        |
| 3     | `routes/_chat.$environmentId.$threadId.tsx` | ±0    | 2     | 32   | existing row rewritten in place          |
| 4     | `settings/settingsSearch.ts`                | ~+13  | 24    | ~312 | **new row** — additive                   |
| 4     | `settings/SettingsSidebarNav.tsx`           | +2    | 19    | ~38  | **new row** — additive                   |
| 5     | `mcp/McpHttpServer.ts`                      | +2/−1 | 2     | 6    | **new row** — measured, not `[A]`        |
| 6     | mode-switch mount                           | ~+2   | —     | —    | **new row** — additive, deferred         |
| —     | `packages/contracts`                        | 0     | —     | —    | D12 — and it is why phase 5 takes path B |
| —     | `Sidebar.tsx` / `Sidebar.logic.ts`          | 0     | —     | —    | a loop is a pinned thread                |
| —     | `server.ts`                                 | 0     | —     | —    | already has its row                      |

**Total: 3 new rows for phases 1–4** (~16 lines), **4 for phases 1–5** (~18 lines), all additive,
plus one deferred. For comparison, the ledger carries 53 rows at +2609/−981.

Two things the re-measurement changed, both worth stating because they invert the intuition the
earlier drafts built:

- **Phase 5 got much cheaper.** It was `0–3 rows [A]`, priced as the scary one. Measured, it is one
  row at risk **6** — the three `mcp/` files are churn 1–2, the quietest neighbourhood in this plan.
- **Phase 4 got much dearer.** `settingsSearch.ts` went churn 14 → 24, so the two settings rows now
  carry ~350 of the plan's ~411 total risk. The most expensive thing in this feature is the
  navigation entry, not the reactor, not the adapter hook, and not the agent-facing tools.

The row count is what recurs at every sync; the line count is a one-time write.

---

## 7. Test strategy

183 cases in TESTS.md, plus the three coverage gates in its §11. Structure:

- **Pure and fast** — `decide.ts` and `guards.ts` are pure so the entire decision table tests
  without a server or clock. Target **100% branch coverage** on both.
- **Property-ish invariants** rather than only examples: one table-driven case asserting _every_
  skip guard leaves the budget unchanged, so a future guard added without that property fails.
- **A schema-reflective test** that fails if a field is added to the record without a decoding
  default — that omission silently disarms every loop on the machine.

The four to write first:

1. Self-paced healthy ⇒ T3 fires zero times. _(the "does not fight the agent" regression)_
2. Self-paced wake lost to a restart ⇒ covered exactly once. _(the durability gap, as a test)_
3. The empty console. _(the degradation property)_
4. `spent` is never reported as `done`.

Two more that the #125 review added to the front of the list, because each pins a hole that was
open in the docs rather than a behaviour that might regress:

5. A deadline that has passed stops the loop **while the thread is busy** (guard 4b). Without it,
   every ○ guard above the old guard 13 was a way to walk past a deadline.
6. An **auto**-settle does not stand the loop down (guard 5 retired). The fork has already lost an
   armed auto-resume to this exact server sweep.

---

## 8. Rollout

- **Default off** at every level: env kill switch, master setting, per-thread arm.
- **Dogfood** on this repo's own overnight runs before anything else.
- **Kill path:** `COIL_LOOP_ENABLED=0` stops the fiber forking at layer construction — the only
  condition under which no fiber exists. The master toggle is a **guard**: re-read every tick _and_
  immediately pre-dispatch, so it is a true kill switch rather than one-tick-stale, and it stands
  loops down without disarming or stopping any of them.
- **Blast radius if wrong:** bounded by the mandatory budget (≤20 check-ins/loop) and the armed-loop
  ceiling (default 3). Worst case is `3 × 20 = 60` unwanted turns, and the reserve-before-dispatch
  discipline means a broken provider burns budget rather than tight-looping.

---

## 9. Risk register

| Risk                                                                                                                  | Likelihood                | Impact                       | Mitigation                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_crons` arrives as a cron _expression_, not a fire time, so the `nextFireAtMs` parse is ours and can be wrong | Medium `[A]`              | Deference misfires           | Narrowed by review: **delivery of the field is settled** `[V - external]`, only the parse is still `[A]`. **Phase 1 is designed to find this out cheaply** — it logs the parse beside the raw `schedule`. Fallback is pure staleness with a longer threshold — worse, but zero upstream cost        |
| Upstream ships its own automations feature                                                                            | Medium                    | Duplicated work              | Zero contracts edits means the fork becomes a _caller_, not a migration. Re-check each sync                                                                                                                                                                                                         |
| The `ClaudeAdapter` row conflicts on a sync                                                                           | Low-Medium                | Recurring cost               | One additive line beside an existing spread; fails to a type error, not silent drift                                                                                                                                                                                                                |
| A loop pushes past a human decision                                                                                   | Low                       | Trust                        | Three separate guards (approvals, pending input, plan-ready), each non-consuming                                                                                                                                                                                                                    |
| Token burn from a runaway loop                                                                                        | Low                       | Cost                         | Mandatory budget, deadline, armed ceiling, reserve-before-dispatch, strike detector                                                                                                                                                                                                                 |
| Model never calls `raise_blocker`                                                                                     | **High**                  | Console thinner              | By design: two of three console sources need no model cooperation. This is the acceptance test                                                                                                                                                                                                      |
| `spent` misread as success                                                                                            | Medium                    | The original problem returns | Distinct colour, distinct word; asserted in tests (cases 17, 137). **Push copy is designed in the report and not built** — it has no phase and no tests, so it is listed under §3 Out rather than counted as mitigation (issue #125 §B8)                                                            |
| `settingsSearch.ts` conflicts                                                                                         | **High** `[V — churn 24]` | Small recurring              | Append-ordered array, same add/add shape as #29. The #7082 ordering is already satisfied. Re-measured 2026-09-02 the churn is 24, not 14, and `a19f01fc1` added another entry the same day — so expect this row to conflict most syncs. §6 records the zero-row fallback if it stops being worth it |
| An **auto**-settle or **auto**-anything reads as human intent                                                         | **High** `[V]`            | A loop silently retires      | Guard 5 retired (BACKEND §7). The general rule the fork keeps re-learning: upstream automates a user-only signal, and every guard reading _intent_ from it inverts. Audit each guard against "could a server timer write this?" before adding it                                                    |

---

## 10. Open questions for review

The four places an outside opinion is most valuable.

**Q1 — Is the deference rule right, or too clever? — RESOLVED 2026-09-02.**
The rule stands, and both of its loose ends are closed. **The deadline is the cap**; no `maxDeferMs`
knob is added, because a second knob would have to be explained in terms of the first and every
value other than "the deadline" describes a run that is nominally armed but knowingly unsupervised.
And **`deadlineAtMs` is mandatory at arm time and is not nullable** — the route returns
`400 deadline_required` and never clamps (D9). So "a loop with no cap to defer to" is not a
reachable state rather than a branch anyone has to handle, and the whole rule is one sentence: _T3
stands down while a recorded wake's `nextFireAtMs` is at or before the deadline and is not yet
overdue by its grace._ The grace boundary is **inclusive**. The original text follows, for the
reasoning.

T3 stands down while a recorded wake is still pending — any legal delay, not merely one inside the
threshold window — **up to the loop's own wall-clock deadline**, and covers the wake once it is
overdue by a grace derived from the recorded entry: `max(90s, min(10% of the period, 15min))` for a
recurring entry, 90s for a one-shot. Those numbers are the binary's own — its scheduler "adds a
small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their
period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early"
`[V - external]`. Only the _late_ half can produce a false miss, and covering a merely-jittered wake
would fire the design's strongest trigger against a perfectly healthy thread.

**The deadline cap was added by review**, and it replaces a retracted argument that the exposure was
bounded without a second rule because `ScheduleWakeup` clamps a delay to an hour. It is not:
`CronCreate` writes the same `session_crons` field with an unbounded cron expression, so a recorded
`0 9 * * *` would stand T3 down for a day.

The alternative to all of it is that T3 always paces on its own clock and simply tolerates
occasional double-firing. Deference is more correct and more complex. _Is the complexity worth it,
or should v1 pace unconditionally with a long threshold?_

**Q2 — Should the console be loop-only, or a global inbox from day one?**
Prototype P7 shape C makes it a cross-thread "needs you" surface. It is barely more work, it is
useful with loops switched off, and it might be the more valuable feature. _Is the loop the right
container for this at all?_

**Q3 — Is `raise_blocker` worth the MCP toolkit, or should it be a file? — the price is now
measured.** The toolkit costs **one** seam row at risk 6, not the three the archived design
estimated (§6, BACKEND §11). That does not settle the question — a file is still cheaper and still
worse — but it removes the seam argument from the file's side of it. The original follows.

A blocker could be a line the agent appends to `.coil/blockers.jsonl`, read by the same read-only
supervisor that stats the done-file. That is provider-agnostic with **zero** MCP work, at the cost
of no structured options and no immediate confirmation to the agent. _Cheaper and worse, or cheaper
and sufficient?_

**Q4 — Is the budget model right?**
Check-ins + wall-clock, deliberately not dollars (D8, based on an unverified reading of
`total_cost_usd` `[A]`). _Should someone measure that field first, and would a dollar cap change the
design?_

---

## 11. What would falsify this plan

Stated so a reviewer can aim at evidence rather than opinion.

| If this turned out to be true                               | Then                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our parse of `schedule` disagrees with what actually fires  | Deference degrades to pure staleness with a longer threshold; the `ClaudeAdapter` row still earns its keep on restart coverage alone                                                                                                                                                                    |
| `cron_durable` flips to **true** upstream                   | Claude's crons survive restarts; the durability argument weakens sharply and this feature shrinks to bounds + console                                                                                                                                                                                   |
| Upstream ships a supervision/automations feature            | Re-cut against it. The console and the question channel probably survive; the reactor probably does not                                                                                                                                                                                                 |
| `AskUserQuestion` becomes non-blocking                      | D6 collapses — one channel suffices, and `raise_blocker` is unnecessary                                                                                                                                                                                                                                 |
| The user's real loops are almost never blocked on questions | The console is over-built; ship the reactor and the status pill only                                                                                                                                                                                                                                    |
| Pinning is removed or reworked upstream                     | D3 collapses back to the Direction A/B/C comparison, and C becomes the answer. **Partly realised already**: `f70eeeeb0` reworked pin-vs-settle so a settled loop leaves the pinned block. D3 survived because its load-bearing claim was the zero row count, not the visibility — see the D3 note in §2 |
| Upstream continues threads across restarts by default       | D1's durability argument narrows. **Checked**: `5b7d72aad` (#9167) does this, but only for threads with a live `activeTurnId`, only on the intentional self-update path, and only behind a setting that ships **off** — a pending wake is never marked. BACKEND §12                                     |

**One falsifier has been struck.** The table's top entry used to read "`session_crons` is
empty/absent in practice on real Claude sessions". It is **refuted**: the binary spreads
`{ background_tasks, session_crons }` unconditionally into both the `Stop` and `SubagentStop` hook
inputs and maps each entry to `{ id, schedule, recurring, prompt }`, emitting `[]` rather than
nothing when a session has no crons `[V - external]`. The narrower successor — that our _parse_ is
wrong — takes its place, and Phase 1 still answers it.

---

## 12. Immediate next actions

1. ~~Review this plan~~ — done, twice: four reviews before #120 merged, then issue **#125**, whose
   findings this revision resolves. What changed is listed below.
2. Decide Q1–Q4. **Q1 is resolved** (§10). Q2, Q3 and Q4 remain open; Q3's seam argument is now
   measured rather than estimated.
3. Open a consolidated issue; close #42 pointing at it; note the residue of #38 is now covered.
4. Start **Phase 0** — it is pure debt paydown, zero seam, and safe to do before any decision lands.
5. Start **Phase 1** — it answers the biggest remaining `[A]` in the plan, the `schedule` parse, at
   the cost of one additive line.
6. When the design is accepted, register its vocabulary (loop, check-in, blocker, deference,
   held / spent / stalled, iteration ledger) in `docs/coil/CONTEXT.md` — created lazily then, per
   `docs/coil/agents/domain.md`, not before.

### What the #125 review changed

Grouped by whether it changes behaviour, cost, or only the words.

**Behaviour — four fixes, two of which were latent bugs rather than contradictions:**

- `deadlineAtMs` is **mandatory and non-nullable**; the route 400s. The null branch in guard 10b —
  which meant _no deference at all_, so a deadline-less loop fired on top of a healthy self-pacing
  thread — is gone (§A1).
- **Stop conditions moved from guard 13 to guard 4b**, ahead of every non-consuming skip. They were
  evaluated only on a tick that had already decided the thread was idle, so a busy self-paced run
  walked past its own deadline and a `done` sentinel went unnoticed until the thread went quiet.
- **Guard 5 (`settledOverride !== "settled"`) is retired.** Upstream #8600 made settlement a
  server-side sweep with no provenance marker, so the flag no longer carries human intent — the same
  correction `autoResume/guards.ts` already made after a timer destroyed an armed week-long resume.
- **`thread.pin` is a promotion, not a decoration** — it emits companion `thread.unsettled` /
  `thread.unsnoozed`. Arming a snoozed thread now 400s; disarm unpins only what the loop pinned.

**Cost — re-measured against the 2026-09-02 merge-base `941acb4f9`:** phase 5 fell from `0–3 rows
[A]` to **1 row at risk 6**; phase 4 rose to ~350 risk and is now the most expensive part of the
feature; the phase 3 row is cheaper than recorded. `store.global.enabled` gained a data model and
routes and **moved from phase 4 to phase 2**, because phases 2 and 3 were otherwise unswitchable.

**Words — contradictions closed:** the master toggle has one semantic (§A3, a guard, never "no
fiber"); the grace boundary is inclusive everywhere (§A4); D2's "never `session.status`" is scoped
so a PLAN-only reader keeps the long-tool-call case (§A5); the console-precedence reversal is
declared with its reason (§A2); push, mobile row chrome and the run digest move from "designed" to
**Out** (§B8, §B9); `gate_off` gets a verified source and a named render slot (§B10); the archived
design's superseded-by banner names the premises that actually moved (§A6).
