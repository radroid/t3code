# Loops — backend design

**Decision taken 2026-08-15:** a **durable, T3-native scheduler**, fork-owned, provider-agnostic.
Claude's own cron tools become an *observed signal* and a *thing to bound*, never the mechanism.

This document explains what gets built, why each piece is shaped the way it is, and — as
importantly — the four architectures that were considered and rejected. Line references are
against the current tree (merge-base `196c8ea0d`, 2026-08-14 sync), not the 2026-08-02 base the
archived design used.

---

## 0. The one-paragraph version

A fork-owned reactor ticks once a minute. For each **armed** thread it reads one SQL projection
column — `updatedAt` — and if the thread has been silent past its threshold and all fourteen guards
pass, it dispatches an ordinary `thread.turn.start`, exactly as auto-resume already does in
production. Budget, deadline, strikes and stop reasons live in a durable JSON file so a 3am reboot
loses nothing. A second, non-blocking question channel (`raise_blocker`, an MCP tool) lets the agent
bank a human decision without halting, and the console reads blocking pending-inputs, deferred
blockers and the loop's own stop reasons from three independent sources — so it stays useful even
if the model never cooperates.

Total new upstream surface: **one line** in an existing fork-owned aggregator, plus **one**
existing seam row rewritten in place. Everything else is new files upstream has never seen.

---

## 1. Why not the four alternatives

These are ordered by how attractive they look before you check.

### 1.1 Rejected — build on Claude's own cron/`ScheduleWakeup`

This is what issue #42 established is *possible*. `CronCreate`, `CronDelete`, `CronList` and
`ScheduleWakeup` are compiled into the Claude platform binary, spread unconditionally into its tool
registry, and the scheduler is constructed inside the **non-interactive** `print.ts` entrypoint —
the same one the SDK uses. On fire it injects a synthetic prompt and kicks its own drain loop, and
T3 already handles the resulting turn (`ClaudeAdapter.ts` auto-starts a synthetic turn for
assistant messages arriving without one). So `/loop 2m say hi` typed into a composer plausibly
works today with zero code.

It is still the wrong foundation, for four independent reasons, any one of which is disqualifying:

| | Why it fails |
|---|---|
| **Session-lifetime only** | `tengu_kairos_cron_durable` is **false**, so `durable:true` silently downgrades to an in-process table. `ProviderSessionReaper` stops a binding after 30 minutes of inactivity, and a *pending wake is not an active turn*. `ScheduleWakeup` clamps delay to `[60, 3600]`. Any delay over ~1800s is dead on arrival and **nothing on disk records that it was ever scheduled.** |
| **Gated remotely, with no local override** | `ScheduleWakeup`'s runtime gate is code-default **false**, currently true only because a GrowthBook evaluation was cached to `~/.claude.json`. There is no env escape hatch. Worse, `ClaudeHome.ts` relocates `CLAUDE_CONFIG_DIR` per provider instance — so the same build can have working loops on one instance and silently dead ones on another, because the gate cache moved. |
| **Claude-only** | Nothing equivalent exists under `codex`, `cursor`, `grok`, `opencode`. Any UI built on it is a dead affordance on four of five adapters. |
| **Nothing to bound it with** | The binary owns the cron table; T3 has no handle on it. You cannot cancel, cap, budget or audit what you cannot address. |

**What we keep from it.** The `Stop` hook's `session_crons` field is real and is the only way to
know *"is this thread going to wake itself, and when"*. That is worth reading — later, as
observability, to detect and warn about a **second scheduler** fighting ours. It is Phase 3, and
it is not load-bearing.

### 1.2 Rejected — a DB migration for loop state

The migration registry is upstream-owned. Adding to it buys permanent conflict surface for what one
JSON file does fine. `autoResume/state.ts` says this outright and has been right for months.

### 1.3 Rejected — a `thread.loop.*` command in `packages/contracts`

`contracts/orchestration.ts` is churn-12 and is upstream #5123's pre-announced landing zone (the
`ThreadSnoozeCommand` comment). Zero contract edits means when upstream ships its own automations
concept, this feature becomes a *caller* rather than a migration.

### 1.4 Rejected — arming on turn boundaries instead of an idle clock

The archived design killed this twice over and both kills re-verify. `stopSessionInternal` calls
`completeTurn(context, "interrupted", …)`, emitting a real-turnId `turn.completed` when the **user
hits Stop** — arming on that restarts exactly the work they just killed. And the `if (!turnState)`
branch emits `turn.completed` with **no** `turnId` while still carrying `totalCostUsd`, so any
turnId-keyed denylist arms falsely. A denylist is also hot-stream-only and therefore empty after
every restart: it fails **open**.

---

## 2. Module layout

Mirrors `apps/server/src/coil/autoResume/` file-for-file, because that module is proven in
production and its shape is already reviewed.

```
apps/server/src/coil/loop/
  Reactor.ts        two self-starting scoped fibers (tick + rate-limit tap)
  state.ts          durable JSON store, SynchronizedRef + atomic write
  decide.ts         pure: record + shell + now  ->  Decision
  guards.ts         pure predicates, one per guard
  config.ts         env defaults + prompt resolution
  sentinel.ts       stat the done-file, worktree-first
  blockers.ts       the deferred-question store
  http.ts           raw routes under /api/coil/loop
  *.test.ts         one per module

apps/server/src/mcp/toolkits/loop/
  tools.ts          raise_blocker, loop_status, loop_done
  handlers.ts
  *.test.ts
```

`decide.ts` being **pure** is the single most important structural choice: it makes the entire
decision table testable without a server, a clock, or a provider. Every row in §9's test list that
says "pure" runs in microseconds.

---

## 3. Data model

One file, `coil-loop.json`, in `ServerConfig.stateDir`.

```ts
LoopRecord = {
  armed: boolean                    // default FALSE. Nothing is supervised implicitly.
  armedAtMs: number
  goal: string | null               // what the user said they wanted, for the console header
  workSource: "thread" | { kind: "issues"; repo: string; label: string }

  // budget — mandatory, no unlimited mode
  maxCheckIns: number               // <= 20, enforced in the route with a 400
  checkInsUsed: number
  deadlineAtMs: number | null

  // thresholds, per-thread overridable
  idleMs: number                    // default 15 min
  busyIdleMs: number                // default 45 min

  // liveness bookkeeping
  lastCheckIn: { firedAtMs: number; createdAtIso: string } | null
  strikes: number
  rateLimitedUntilMs: number

  // terminal state — sticky, only a human re-arm clears it
  stopped: null | {
    reason: "done" | "spent" | "stalled" | "handed-back"
    atMs: number
    detail: string
  }

  overridePrompt: string | null
}
```

**Every field is `Schema.withDecodingDefaultKey`.** This is not style. A missing *required* key
fails the whole-file decode, and the boot path turns a decode failure into `EMPTY_STATE` — which
would silently disarm every loop on the machine. `autoResume/state.ts` carries this warning in a
comment and it is the highest-severity footgun in the module.

Blockers live in a sibling map keyed by thread:

```ts
Blocker = {
  id: string
  raisedAtMs: number
  question: string
  options: { label: string; description: string }[]   // may be empty = free text
  context: string | null                              // file/issue the agent was on
  answeredAtMs: number | null
  answer: string | null
  deliveredToAgent: boolean       // has the agent been told the answer yet
}
```

`deliveredToAgent` is the field that makes answering work asynchronously: the console can accept an
answer at 09:04 while the thread is idle, and the next check-in prompt carries it.

---

## 4. The trigger

```
idleMs    = now - max(Date.parse(shell.updatedAt), processStartedAtMs)
threshold = busyTurn ? config.busyIdleMs : config.idleMs
fire when idleMs >= threshold
```

`busyTurn` is `shell.session?.status ∈ {running, starting} || shell.latestTurn?.state === "running"`.

**Why `updatedAt` and nothing else.** `thread.activity-appended` is grouped with
`thread.message-sent` in the projection pipeline and rewrites the row with
`updatedAt: event.occurredAt`. Background subagent `task.*` events become activity appends. So on
the thread that motivated all of this — 1,358 orphaned activities after a turn closed — the
predicate stayed quiet through all of them and would have fired at ~01:07 instead of the human
typing at 04:23. It reads **a SQL projection column, not a hot stream**, which is why it is the
only trigger in the field that survives a mid-loop server restart.

**`session.status` appears nowhere in the guard table, and that is the single most important line
in the design.** A background subagent's assistant message auto-opens a synthetic turn that pins
`session.status = "running"`, and nothing closes it. Reusing `autoResume`'s `threadIsProgressing`
as a veto would deadlock permanently on exactly the threads this feature exists to save. Here
`running` only *lengthens* the fuse.

**`processStartedAtMs` is a required boot-grace floor.** Without it every armed thread fires
simultaneously on the first tick after a restart — and this user's machine restarts the app
routinely. The same clamp covers laptop sleep.

Reads per armed thread per tick: `getThreadShellById` + `getProjectShellById`. **Never
`getSnapshot()`** — note `autoResume/Reactor.ts` still calls it and has an open OOM follow-up, so
this module is deliberately better than the one it copies. Zero SQL when nothing is armed.

---

## 5. Firing

Byte-for-byte the shape `autoResume/Reactor.ts` already uses:

```ts
engine.dispatch({
  type: "thread.turn.start",
  commandId: CommandId.make(`coil-loop:${uuid}`),
  threadId,
  message: { messageId: MessageId.make(`coil-loop:${uuid}`), role: "user", text, attachments: [] },
  runtimeMode: shell.runtimeMode,
  interactionMode: shell.interactionMode,
  createdAt,
});
```

Three disciplines, each closing a specific hole:

1. **Reserve before dispatch.** `store.recordCheckIn(...)` persists *before* `engine.dispatch`. This
   is the only unbounded path in the design: a provider that cannot spawn otherwise tight-loops. It
   burns budget instead — 6 attempts, not 480 a night.
2. **Re-read the shell immediately before the guard block and again before dispatch.** Freshness
   discipline lifted from `autoResume/Reactor.ts`; it closes the wake race.
3. **Repair the keep-active pin.** `decider.ts` clears `settledOverride` for any non-null value and
   `snoozedUntil` unconditionally, with no opt-out. So when the pre-dispatch shell showed
   `settledOverride === "active"`, follow the turn start with a `thread.unsettle` (`reason: "user"`)
   — issued **only** when the pin was already there, so it can never create one.

Because the nudge is an ordinary user turn through the existing streaming-input session, the user's
`~/.claude` and `.claude/` hooks, skills and slash commands apply to a loop turn exactly as to a
terminal one, and `--resume` respawn is already handled. **Nothing touches `SDKResultSuccess`,
`total_cost_usd`, `session_crons` or `raw.method`, so an SDK bump cannot break it.**

---

## 6. The check-in prompt

Resolution order: per-thread override → `<cwd>/.coil/loop-prompt.md` → built-in. `<cwd>` is
`worktreePath ?? workspaceRoot` — **worktree first**, because `resolveThreadWorkspaceCwd` returns it
first and that is the agent's real cwd. (`autoResume/Reactor.ts` has this precedence *inverted*;
copying it would silently break the stop signal on every worktree-backed thread.)

Restated **in full every time**, because a six-check-in overnight run will compact and a contract
taught once is gone by check-in four. The prompt carries, verbatim: the check-in number and budget,
the instruction not to restart from the top, the absolute interpolated path of the done-file, the
deadline, **any answers banked since the last check-in**, and the line
*"I am the scheduler for this thread. Do not schedule your own wake-ups."* — which resolves the
real collision with the user's own `autonomous-build-loop` skill in one sentence.

---

## 7. Stop conditions and guards

Terminal states are **sticky**; only a human re-arm clears them. Each writes a breadcrumb.

1. **`done`** — the agent wrote `<root>/.coil/loop-done`. Stat both roots, **worktree first**,
   newest mtime wins, honoured only when `mtime > armedAtMs`. The supervisor is **read-only** —
   it never writes to the user's filesystem, which is what makes it safe to point at any repo.
   All freshness is `fs.stat().mtimeMs`, **never** a timestamp a model typed into a file: models do
   not know the wall clock, and gating `done` on a model-authored timestamp makes `done` unreachable
   whenever it guesses wrong.
2. **`spent`** — budget or deadline exhausted. Zinc, and **never** rendered as success.
3. **`stalled`** — two consecutive check-ins where the thread moved less than `productiveMs` (2 min).
4. **`handed-back`** — `shell.latestUserMessageAt > lastCheckIn.createdAtIso`. Takeover **disarms**;
   it is not a budget reset. Reading output for twenty minutes must not get you nudged mid-thought,
   and deliberately stopping a thread must not hand the loop a fresh six.

**Guards, in order.** Non-consuming skips are marked ○ — they keep budget and surface a reason.

| # | Guard | On fail |
|---|---|---|
| 1 | `config.enabled` (env kill switch, checked at layer construction) | no fiber forks |
| 2 | `store.global.enabled` — re-read **every tick and again pre-dispatch** | ○ the settings toggle is a true kill switch, not one-tick-stale |
| 3 | `record.armed === true` | ○ |
| 4 | shell is `Some`, not archived, is a supported thread | **disarm** |
| 5 | `settledOverride !== "settled"` | ○ |
| 6 | `snoozedUntil == null \|\| <= now` | ○ the only way to honour a snooze |
| 7 | `settledOverride === "active"` ⇒ nudge **then** repair pin | — |
| 8 | `!hasPendingApprovals && !hasPendingUserInput && !hasActionableProposedPlan` | ○ |
| 9 | `autoResumeStore.getThread(threadId).pending === null` | ○ |
| 10 | `now >= record.rateLimitedUntilMs` | ○ |
| 11 | `now - lastCheckIn.firedAtMs >= config.idleMs` | ○ structural floor: a tight loop stays impossible even if `updatedAt` fails to bump |
| 12 | idle threshold met, on a freshly re-read shell | ○ |
| 13 | budget, deadline, strikes, sentinel | **stop** |
| 14 | armed threads `< maxArmedThreads` — enforced in the route **and** re-checked in the tick | ○ not bypassable by hand-editing the state file |

Guard 8's third clause is the one every design in the original panel missed. `Sidebar.logic.ts`
treats plan-ready as **not** pending-input, so a thread parked on an unapproved plan otherwise
passes every other blocking guard and gets pushed past the human's yes.

---

## 8. Not fighting auto-resume, and surviving limits

Guard 9 is one direction. The other direction needs its own fiber, because `autoResume`'s scheduler
only arms when *its* per-thread `enabled` is true — so on a thread where the user turned auto-resume
off, a rate limit produces no pending, guard 9 passes, and the loop nudges straight into a live
5-hour limit.

So the loop runs a **second scoped fiber** tapping `providerService.streamEvents` for
`account.rate-limits.updated`, reusing the fork's own `classifyRateLimit` (imported, not
re-mirrored), and on a rejected verdict writes `rateLimitedUntilMs` to the **durable** store —
durable, not in-memory, so it survives the restart that would otherwise reopen the hole.
`streamEvents` is PubSub-backed, so a second subscriber does not steal auto-resume's events.

Belt and braces: a nudge rejected by a limit produces no `updatedAt` movement, so it takes a strike
and stops after two.

**User-visible contract:** while held, the loop spends **nothing**, auto-resume owns the wake, and
the console says *"Held — usage limit until 08:22"*, which must read differently from *"stalled"*.
One of the two failures on the original night was a human unable to tell these apart.

---

## 9. The question channel — the genuinely new part

### 9.1 The problem, precisely

`AskUserQuestion` already exists and already works: the adapter intercepts it in `canUseTool`,
emits `user-input.requested` with a structured `{ id, header, question, options[], multiSelect }`
payload, and the projection surfaces it as `hasPendingUserInput`. It renders natively.

And it **blocks**: `const answers = yield* Deferred.await(answersDeferred)`.

An agent that hits a genuine fork in the road at 01:00 and asks about it *correctly* stops working
until 09:00. Guard 8 then refuses to nudge it — also correctly, because pushing past a pending
decision is worse. The loop and the question channel are in direct tension, and no tuning resolves
it.

### 9.2 The fix — a second, non-blocking channel

A fork-owned MCP tool, `raise_blocker`, that **records and returns immediately**:

```
raise_blocker({ question, options?, context? }) -> { id, "recorded" }
```

The agent parks *that branch of work* and continues with something else. The answer is delivered on
a later check-in via the prompt, not by unblocking a Deferred.

**Why HTTP MCP and not `createSdkMcpServer`.** `mcpServers` is already wired in **all five**
adapters to a T3-hosted HTTP MCP server with a per-thread bearer credential, and
`McpInvocationContext` already carries `{ environmentId, threadId, providerSessionId, … }` — so the
tool knows which loop is calling without being told. `createSdkMcpServer` is Claude-only, would
require a `ClaudeAdapter` edit anyway, and would duplicate a host that already exists with auth and
scoping. There is a complete working template at `mcp/toolkits/preview/`.

### 9.3 Why this does not repeat BATON's mistake

The archived design rejected an agent-authored contract because it "outsources the hardest judgement
to the thing that just failed" and "degrades silently". This does not, for one structural reason:
**the console has three sources and only one of them needs the model.**

| Source | Needs model cooperation? | Where it comes from |
|---|---|---|
| Blocking: approvals, pending input, plan-ready | **no** | SQL columns on the thread shell |
| Loop-authored: skip reasons, stop reason, budget | **no** | fork-owned store |
| Deferred blockers | yes | `raise_blocker` |

A model that never calls `raise_blocker` still produces a correct console — it just has fewer rows.
It degrades to *"the loop is spent, and nothing is waiting on you"*, which is true and useful,
rather than to silence. **That is the acceptance test**, and it is why the prototype renders the
empty state explicitly.

### 9.4 Two more tools, both small

- `loop_status()` → the agent's own budget: *"check-in 4 of 6, 51 minutes to deadline"*. Lets a
  well-behaved agent scope its remaining work. Read-only.
- `loop_done(reason)` → a tool-shaped alternative to writing the sentinel file, for agents in
  environments where writing is awkward. The **file remains the primary contract** because it works
  from a plain terminal with no MCP at all.

---

## 10. HTTP surface

Raw routes, following `webPush/http.ts` verbatim — whose header comment states the rule: an RPC
would force edits to `@t3tools/contracts`, `ws.ts` and its scope map. A raw route costs one
additive line in a list.

```
GET  /api/coil/loop?threadId=…      -> record + derived state + blockers + ledger
POST /api/coil/loop                 -> arm / disarm / edit bounds / re-arm after terminal
POST /api/coil/loop/answer          -> answer a blocker or a native pending input
GET  /api/coil/loops                -> all loops (the workspace view)
```

Operate scope, not read — these mutate scheduling. `authenticateWithOperateScope` currently exists
as **two independent pastes** (`autoResume/http.ts`, `webPush/http.ts`) and only one is in the
ledger; this feature moves it to a shared `coil/http/auth.ts` rather than becoming a third.

---

## 11. Seam cost

| File | Delta | Note |
|---|---|---|
| `apps/server/src/coil/index.ts` | +~6 | **fork-owned, churn 0** — store, reactor, routes |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` | **±0** | existing row (+10/−6, risk **0**) rewritten in place: `<AutoResumeOverlay>` → `<ThreadCoilOverlay>`, which then hosts both. Genuinely delta-zero, and every future per-thread fork surface is free forever. |
| `apps/server/src/server.ts` | **0** | already has its 3-line row |
| `packages/contracts` | **0** | activity `kind` is an open `TrimmedNonEmptyString`, payload is `Schema.Unknown` |
| `Sidebar.tsx` / `Sidebar.logic.ts` | **0** | a loop is a **pinned thread** — `thread.pin` already exists |

The settings surface is the one open bill, and it is a genuine choice:

- **Own section** (`/settings/loops`) — costs the `SettingsPath` union + `SETTINGS_SECTION_LABELS`
  + `SETTINGS_SECTION_ICONS` in `settingsSearch.ts`, a new route file, and a `routeTree.gen.ts`
  regeneration. `settingsSearch.ts`'s single append-ordered array is structurally the same add/add
  conflict shape as issue #29.
- **Ride inside General** — cheaper, but buries a feature that owns unattended spend.

Recommendation: **own section.** A feature that can spend money while you sleep should be findable
by name, and `settingsSearch.ts` is a young file whose "churn 1" is a measurement artifact rather
than a stability signal — it will move regardless.

`searchableSetting()` registration is skipped (its id union is closed to the upstream catalog),
making this the fork's second search-invisible surface. That must be noted under the ledger table,
not left implicit.

---

## 12. Restart safety

State is durable JSON; the trigger is a SQL column. A reboot at 3am loses nothing: armed threads
stay armed, and budgets, deadlines, strikes, `armedAtMs` and `rateLimitedUntilMs` all survive.
`processStartedAtMs` stops the first post-boot tick from firing everything at once.

This is the property **no event-edge design has**, because both `providerService.streamEvents` and
`engine.streamDomainEvents` are hot-only. It is also the half of #38 that upstream's
`ThreadBackgroundLiveness` explicitly does not provide — its own module doc says *"no persistence,
no migration. After a server restart the registry is empty."*

---

## 13. What this honestly does not solve

- **A single silent tool call longer than `busyIdleMs` reads as idle**, and the check-in is then
  absorbed as a steer into the live turn with no visible turn boundary. `busyIdleMs` is a tunable
  magic number, not a solution.
- **Without an adopted done-file, `done` is unreachable and every run ends `spent`.** That is why
  the path is interpolated absolute, the contract restated every check-in, and `spent` visually
  distinct.
- **Cost is not metered in dollars.** Budget is check-ins and wall-clock. `total_cost_usd` flows
  from `SDKResultSuccess`, nothing in this repo has ever read it, and the SDK's own documented use
  describes it as accumulated **by the session** — so summing per turn would inflate quadratically
  and a "$25 cap" would trip around iteration 6 of a $4 run. A ledger whose selling point is trust
  cannot rest on an unverified number. Revisit only after measuring it.
- **A derailed agent still burns budget.** Strikes catch the *dead* failure, not the *wrong-work*
  failure. Nothing here reads what the agent actually did.
