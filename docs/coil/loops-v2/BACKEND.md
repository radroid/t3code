# Loops — backend design

**Decision taken 2026-08-15:** a **durable, T3-native scheduler** that **backstops the agent's own
scheduler rather than replacing it**. Fork-owned, provider-agnostic.

> **Revised 2026-08-15, same day.** The first draft of this document treated Claude's cron /
> `ScheduleWakeup` as unusable and listed four "fatal" disqualifiers. That was wrong. It inherited
> issue #42's static analysis from 2026-08-07 without re-measuring, and the ground has moved — see
> §1.1. The scheduler works within its range; T3's job is the range it cannot cover. The reactor
> design below is unchanged, but its _role_ is now fallback rather than primary, and reading
> `session_crons` moves from phase 3 to phase 1.

Line references were measured against merge-base `196c8ea0d` (2026-08-14 sync), not the 2026-08-02
base the archived design used; UPSTREAM-DELTA §5 lists the ones that have since moved. Churn and
file-size figures are re-measured against the current merge-base **`941acb4f9`** (the 2026-09-02
sync), which is also the base `docs/coil/SEAMS.md` now carries — **53 upstream-owned files,
+2609 / −981**.

> **Re-baselined 2026-09-02 (issue #125 §D).** Two earlier bases are named in the history of this
> document and both are now superseded. The 2026-08-18 sync moved the base from `a4cc1367b` to
> `cebac353d`; the 2026-09-02 sync (182 upstream commits, issue #128) moved it again to
> `941acb4f9`. **Every churn and risk figure below is re-measured against `941acb4f9`**, and several
> moved a lot — `ClaudeAdapter.ts` 16 → **23**, `settingsSearch.ts` 14 → **24**,
> `_chat.$environmentId.$threadId.tsx` 4 → **2**. Churn is measured over the 60 days _before_ the
> merge-base, so a busier upstream window moves every number without any fork change; compare risk
> within this table, not against a previous revision. The SEAMS.md header no longer lags — that
> follow-up landed as `93c1e67b8`.

**Marker discipline.** `[A]` is an assumption this design has not verified. `[V]` is verified by
command against this tree. **`[V - external]`** is verified by command too, but against a shipped
dependency — the pinned `@anthropic-ai/claude-agent-sdk` types or the Claude binary itself — rather
than against the repo. A `[V - external]` fact can therefore change under you with **no repo diff**
to warn you, which is why it is marked apart rather than folded into `[V]`.

---

## 0. The one-paragraph version

A fork-owned reactor ticks once a minute. For each **armed** thread it reads one SQL projection
column — `updatedAt` — plus the thread's last-known `session_crons`. If the agent has already
scheduled its own wake, and that wake is still pending and lands inside the run's deadline, **the
loop stands down and spends nothing**. Otherwise, if the thread has been silent past its threshold
and all guards pass, it dispatches an ordinary `thread.turn.start`, exactly as auto-resume already
does in production.
Budget, deadline, strikes and stop reasons live in a durable JSON file so a 3am reboot loses
nothing. A second, non-blocking question channel (`raise_blocker`, an MCP tool) lets the agent bank
a human decision without halting, and the console reads blocking pending-inputs, deferred blockers
and the loop's own stop reasons from three independent sources — so it stays useful even if the
model never cooperates.

**On a healthy self-pacing Claude thread this reactor should almost never fire.** How rarely it
fires is the measure of a correct implementation, not a sign it is doing nothing.

Total new upstream surface for phases 1–4: **3 new seam rows, ~+16 lines** — the `hooks` spread into
`ClaudeAdapter`'s existing `queryOptions` object (+1), `settingsSearch.ts` (**~+13**) and
`SettingsSidebarNav.tsx` (+2) — plus one existing seam row rewritten in place at delta zero, and
~6 lines in an existing fork-owned file, which is not upstream surface at all. **Phase 5 adds one
more row, measured 2026-09-02 and no longer an estimate: `McpHttpServer.ts` `+2/−1`, churn 2,
risk 6** (§11). The budget is PLAN §6; §11 below prices each row.
Everything else is new files upstream has never seen.

---

## 1. The alternatives, and what happened to each

Ordered by how attractive they look before you check. The first one is not rejected — it is
composed with, and getting that wrong was the main error in the first draft.

### 1.1 Compose with — Claude's own cron/`ScheduleWakeup`

**This is the correction.** Issue #42 established the mechanism exists: `CronCreate`, `CronDelete`,
`CronList` and `ScheduleWakeup` are compiled into the Claude platform binary, spread unconditionally
into its tool registry, and the scheduler is constructed inside the **non-interactive** `print.ts`
entrypoint — the same one the SDK uses. On fire it injects a synthetic prompt and kicks its own
drain loop, and T3 already handles the resulting turn end to end: a top-level assistant message
arriving with no active turn auto-starts a **synthetic** turn in `ClaudeAdapter.ts`, and the wake's
own SDK `result` closes it through the unconditional `completeTurn` at the tail of
`handleResultMessage`. A self-paced wake therefore renders as an ordinary turn, open and close —
which is what makes deference **observable** rather than a silent gap (§4).

#42 catalogued the real constraints — the reaper race, the remote gate, and the missing product
concept — and already proposed composing with the scheduler rather than replacing it (its Guard #15:
_"a thread with a scheduled wake is not idle; it is waiting"_). The reading that hardened into
"the scheduler is unusable" was the fork's own 2026-08-07 triage of that issue. Re-measured today,
**that reading** does not hold, and the composition model #42 proposed is the one this design
adopts.

**Gate cache, re-read from `~/.claude.json`:**

```
tengu_kairos_cron          true
tengu_kairos_loop_dynamic  true
tengu_kairos_loop_prompt   true     <- new since the #42 analysis
tengu_kairos_cron_durable  false    <- still the real constraint
```

**And the reaper has changed.** Upstream `2c7267ad4` — _"stop the reaper from silently killing live
background subagents"_ (#5677) — added a second skip condition to `ProviderSessionReaper`:

```ts
if (thread?.backgroundLiveness != null) {
  // ProviderSessionReaper.ts
  // provider.session.reaper.skipped-background-work
  continue;
}
```

So a session with live background work is no longer reaped at all, and the 30-minute threshold with
a 5-minute sweep only bites a genuinely idle binding.

**Two tools write `session_crons`, and only one of them is clamped.** `sdk.d.ts` describes the field
as "Session-scoped cron tasks (**CronCreate**, ScheduleWakeup, /loop) that will wake this session
later", and the two writers have different reach `[V - external, @anthropic-ai/claude-agent-sdk@0.3.170,
the version apps/server/package.json pins]`:

- **`ScheduleWakeup`** takes `delaySeconds: number`, documented "Clamped to [60, 3600] by the
  runtime". One shot, at most an hour out.
- **`CronCreate`** takes `cron: string`, "Standard 5-field cron expression in local time", plus
  `recurring?: boolean` — "fire on every cron match until deleted or auto-expired after 7 days".
  **No upper bound at all.**

An earlier revision of this document treated the `[60, 3600]` clamp as a property of self-pacing as
such. It is a property of one tool. §4's deference rule was built on the wider claim and has been
re-bounded accordingly.

**The practical range:**

| Self-paced delay              | Outcome                 | Why                                                                                        |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| <= ~30 min                    | **works**               | fires before the reaper's idle threshold is reached                                        |
| 30-60 min                     | racy                    | depends on the sweep and whether background work kept the binding alive                    |
| > 60 min via `ScheduleWakeup` | impossible              | `delaySeconds` is clamped to `[60, 3600]` `[V - external]`                                 |
| > 60 min via `CronCreate`     | possible, **unbounded** | a cron expression, not a delay — `0 9 * * *` is a legal 24-hour wait `[V - external]`      |
| across a restart              | **lost silently**       | `cron_durable` false, so an in-process table, and nothing on disk records the wake existed |

Self-pacing at a 20-30 minute cadence — the normal case, and what the tooling nudges toward — sits
squarely in the working band. **That is why it works in practice, and the design must not fight it.**
The `CronCreate` row is why T3 still needs a cap of its own: deferring to a wake is only safe while
the wake is close enough to be worth waiting for.

**What is genuinely T3's job**, each constraint re-verified today:

| Constraint                                                                                                                                                                       | T3 owns                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| In-process only (`cron_durable` false)                                                                                                                                           | **durability** — a wake lost to a restart leaves no trace; T3's store _is_ the trace                                             |
| `ScheduleWakeup` clamped to <= 1 hour; `CronCreate` not clamped at all                                                                                                           | both ends — anything longer than the clamp allows, **and** a cap on anything the cron expression allows: the wall-clock deadline |
| Claude-only — nothing under `codex`, `cursor`, `grok`, `opencode`                                                                                                                | the other four adapters, which otherwise get nothing                                                                             |
| Gate is code-default false, true from a cached remote evaluation; `ClaudeHome.ts` relocates `CLAUDE_CONFIG_DIR` per provider instance, so the cache can differ between instances | a **visible degraded state** rather than a loop that silently stops pacing                                                       |
| T3 has no write handle on the binary's table                                                                                                                                     | budget, cap, audit — but it can now **read** it via `session_crons`                                                              |

**So `session_crons` moves from phase 3 to phase 1, and becomes part of the trigger.** If the agent
has a pending wake landing at or before the loop's own deadline, the loop stands down until that
wake is overdue by its jitter grace (§4). A wake past the deadline is not deferred to, because past
the deadline there is nothing left to defer to. The loop's check-in is the fallback for the case the
agent structurally cannot handle: it has stopped, or its wake was lost.

### 1.2 Rejected — a DB migration for loop state

The migration registry is upstream-owned. Adding to it buys permanent conflict surface for what one
JSON file does fine. `autoResume/state.ts` says this outright and has been right for months.

### 1.3 Rejected — a `thread.loop.*` command in `packages/contracts`

`contracts/orchestration.ts` is churn-20 and is upstream #5123's pre-announced landing zone (the
`ThreadSnoozeCommand` comment). Zero contract edits means when upstream ships its own automations
concept, this feature becomes a _caller_ rather than a migration.

### 1.4 Rejected — arming on turn boundaries instead of an idle clock

The archived design killed this twice over. Re-measured, one kill stands and upstream has closed
the other. The one that stands: `stopSessionInternal` calls `completeTurn(context, "interrupted", …)`,
emitting a real-turnId `turn.completed` when the **user hits Stop** — arming on that restarts
exactly the work they just killed. The one that has gone: since upstream `e70cdb478` (2026-08-08,
#5710) the `if (!turnState)` result path emits only `thread.token-usage` plus a
`claude.turn.result-without-active-turn` log — no lifecycle event at all — so a turnId-keyed
denylist can no longer arm falsely from it. What remains, and is sufficient, is that a denylist is
hot-stream-only and therefore empty after every restart: it fails **open**.

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
  crons.ts          Stop-hook subscription: record what the agent scheduled
  blockers.ts       the deferred-question store
  http.ts           raw routes under /api/coil/loop
  *.test.ts         one per module

apps/server/src/mcp/toolkits/loop/
  tools.ts          raise_blocker, loop_status, loop_done
  handlers.ts
  *.test.ts
```

`decide.ts` being **pure** is the single most important structural choice: it makes the entire
decision table testable without a server, a clock, or a provider. Every case in
[TESTS.md](TESTS.md) marked pure runs in microseconds.

---

## 3. Data model

One file, `coil-loop.json`, in `ServerConfig.stateDir`. Its top level is
`{ version: 1, global: LoopGlobalSettings, threads: Record<threadId, LoopRecord> }` — the `global`
key is the master toggle's home, added by review (issue #125 §B7) because the toggle was the
headline kill switch with no data model, no route and no test.

```ts
LoopGlobalSettings = {
  enabled: boolean                  // default FALSE. The master toggle (guard 2).
  maxArmedThreads: number           // default 3, enforced in the route AND re-checked per tick
  defaultMaxCheckIns: number        // default 6, <= 20
  defaultRunMs: number              // default 8h — seeds the arm form, never a fallback deadline
  defaultIdleMs: number             // default 15 min
  defaultBusyIdleMs: number         // default 45 min
}

LoopRecord = {
  armed: boolean                    // default FALSE. Nothing is supervised implicitly.
  armedAtMs: number
  goal: string | null               // what the user said they wanted, for the console header

  // budget — mandatory, no unlimited mode, no null state
  maxCheckIns: number               // 1..20, enforced in the route with a 400
  checkInsUsed: number
  deadlineAtMs: number              // MANDATORY at arm time. Not nullable. See the note below.

  // thresholds, per-thread overridable
  idleMs: number                    // default 15 min
  busyIdleMs: number                // default 45 min

  // what the agent scheduled for itself, from the Stop / SubagentStop hook (§4)
  crons: {
    recordedAtMs: number
    entries: Array<{
      id: string
      schedule: string              // a 5-field cron expression, NOT a timestamp
      recurring: boolean
      prompt: string                // truncated to 1000 chars by the binary — a label, not the prompt
      nextFireAtMs: number | null    // computed fork-side; null when the expression did not parse
    }>
  } | null                          // null = never observed; { entries: [] } = observed and empty
  degraded: null | "gate_off" | "wake_lost"

  // liveness bookkeeping
  lastCheckIn: { firedAtMs: number; createdAtIso: string } | null
  checkIns: Array<{                 // the iteration ledger, bounded by maxCheckIns (so <= 20)
    n: number
    firedAtMs: number
    createdAtIso: string
    activityCursor: string          // where the thread's activity stream stood at nudge time
    outcome: "productive" | "unproductive" | "unknown"
  }>
  strikes: number
  rateLimitedUntilMs: number

  // pin bookkeeping — see §7's "Arming pins, and what that costs"
  pinnedByLoop: boolean             // true only when the arm route created the pin

  // terminal state — sticky, only a human re-arm clears it
  stopped: null | {
    reason: "done" | "spent" | "stalled" | "handed-back"
    atMs: number
    detail: string
  }

  overridePrompt: string | null
}
```

**`deadlineAtMs` is mandatory and is not nullable — decided by review (issue #125 §A1).** Three
files disagreed about this: an earlier revision of §4 flagged "reject arming without a deadline" as
an unresolved change to this contract, PLAN stated the deadline bound with no caveat, and guard 10b
carried a `deadlineAtMs == null` branch that meant _no deference at all_ — so a deadline-less loop
would fire on top of a healthy self-pacing thread, the exact case §0 declares impossible. The
resolution is the one that makes the wrong behaviour unrepresentable: **a null deadline is not a
state.** The route returns `400 deadline_required` (never a clamp — D9), the field is `number`, and
guard 10b's null branch is gone.

Its **decoding default is `0`**, deliberately, and that is the only reason a record can ever be seen
without a real deadline: a file written by a build that predates the field, or one hand-edited to
drop it, decodes to epoch — which is always `<= now`, so guard 4b stops the loop as `spent` on the
first evaluation. Fail-closed. `maxCheckIns` takes the same treatment for the same reason (default
`0` ⇒ immediately spent). A decoding default that meant "unbounded" would turn a corrupted write
into an unbounded overnight spend, which is the single worst outcome this feature can produce.

The `checkIns` array is what makes the console's iteration ledger reconstructable at all: without
`firedAtMs` and the activity cursor recorded _at nudge time_, the history cannot be rebuilt later.
Ledger rows therefore render **derived facts** — turns, activities, files moved between two cursors
— never a model-authored summary of its own work. `workSource` (thread vs an issue queue) lands
with the maintainer loop, **#44**; a decoding default makes adding it then free, which is why it is
absent here rather than stubbed.

**Every field is `Schema.withDecodingDefaultKey`.** This is not style. A missing _required_ key
fails the whole-file decode, and the boot path turns a decode failure into `EMPTY_STATE` — which
would silently disarm every loop on the machine. `autoResume/state.ts` carries this warning in a
comment and it is the highest-severity footgun in the module. **Choose each default so the
fail-closed reading is the one you get**: `armed: false`, `deadlineAtMs: 0`, `maxCheckIns: 0`,
`crons: null`, `pinnedByLoop: false`, `global.enabled: false`.

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

selfPacedWakeMs = record.crons.nextFireAtMs        // from the Stop hook, persisted
graceMs         = wakeGrace(record.crons)          // derived per entry, see "the grace" below
deferrable      = selfPacedWakeMs != null
               && selfPacedWakeMs <= record.deadlineAtMs   // the loop's own clock is the cap

fire when idleMs >= threshold
       && !(deferrable && now < selfPacedWakeMs + graceMs)
```

`deadlineAtMs` is a `number`, never null (§3), so there is no third branch here and no
"deadline-less" case to reason about. The grace boundary is **inclusive**: at exactly
`selfPacedWakeMs + graceMs` the wake counts as lost and T3 fires.

`busyTurn` is `shell.session?.status ∈ {running, starting} || shell.latestTurn?.state === "running"`.

**`shell.backgroundLiveness` is deliberately not in `busyTurn`**, even though it is the exact,
provider-agnostic liveness signal FINDINGS argues for. It is in-memory and empty after a restart —
which is precisely the gap this design exists to close, so a trigger that leaned on it would be
blind in the one case that motivated the feature. It could still be read as a _lengthener_ when
present (non-null ⇒ use `busyIdleMs`), never as a veto; that is an optional refinement, not a
dependency.

**Said plainly, because it is a refusal and not an oversight: this declines #38's proposed Guard
#15**, _"no open tasks in the roster"_ as a veto on firing (`docs/coil/loop/SUBAGENTS.md`). An
empty roster is indistinguishable from a lost roster, so after a restart the veto reads "nothing is
running" on a thread with six live subagents — a veto that fails silent in exactly the window the
loop exists for is worse than no veto. Hence lengthener, never veto. #38's companion ask — surfacing
the open-task count in the pill — is not carried either, for the same reason: a count that is
sometimes zero-because-restarted is a lying label. **PLAN's Divergences section declares both.**
(Distinct from _#42's_ Guard #15, the scheduled-wake deference rule §1.1 adopts — same number,
different issue.)

**The self-paced clause is the deference rule.** While a recorded wake is still pending, T3 does
nothing — no dispatch, no budget spent, and the console reads _"Self-pacing · next wake 02:35"_.
It defers for the whole wait, not merely for wakes landing inside the next threshold window — a
thread waiting on a wake is not idle, it is waiting — subject to the deadline bound below. T3 wins
the moment the wake is **overdue by `graceMs`** with no `updatedAt` movement. So the loop only acts when the agent has **not** scheduled
itself, or when a scheduled wake **passed with no activity** — which is precisely the case an
in-process scheduler cannot cover, because a lost wake leaves no trace of itself.

**And the deference is bounded by the loop's own deadline — added by review, and open to
challenge.** An earlier revision argued the exposure was bounded without a second rule, because
`ScheduleWakeup` clamps a delay to 3600s. That argument is **retracted**: the clamp belongs to one
of the two tools that write `session_crons`, and `CronCreate` takes an unbounded cron expression
(§1.1). Unbounded deference is therefore a hole, not a simplification — a recorded `0 9 * * *`
stands supervision down for up to 24 hours, and a one-shot pinned to a future date stands it down
indefinitely, all while the run is nominally armed. The rule is now: **T3 defers only while the
recorded next fire is at or before the loop's wall-clock deadline.** Past the deadline the run is
over on T3's clock either way, so the deadline is the natural cap and no new config knob is needed;
beyond it T3 paces on its own clock and the ordinary staleness trigger applies.

**Both loose ends are now closed (issue #125 §A1).** The deadline is the cap; no `maxDeferMs` knob
is added, because a second knob would have to be explained in terms of the first and every value
other than "the deadline" describes a run that is nominally armed but knowingly unsupervised.
And `deadlineAtMs` is **not nullable** (§3) — the route rejects an arm without one with
`400 deadline_required`, so "a loop with no cap to defer to" is not a reachable state rather than a
branch to handle. Deference is therefore exactly one sentence: _T3 stands down while a recorded
wake's `nextFireAtMs` is at or before the deadline and is not yet overdue by its grace. Past the
deadline there is nothing left to defer to._

`record.crons` is written by the `Stop` / `SubagentStop` hook callbacks (see §2's `crons.ts`):
read `input.session_crons`, compute `nextFireAtMs` fork-side from `schedule` (one-shot = single fire
time encoded in the fields; server-local tz) `[A — the parse is ours]`, persist per thread.

**The parse is fork-owned, and it must not bring a dependency.** `git grep -i cron -- '*package.json'`
and a `cron` search over `pnpm-lock.yaml` both return **zero** — there is no cron parser anywhere in
this repo `[V]`. Nor should one be added: a general parser handles a grammar the producer never
emits. The producer's grammar is documented and narrow — `CronCreateInput.cron` is
_"Standard 5-field cron expression in local time: `M H DoM Mon DoW`"_, with `*/5` steps and `1-5`
ranges in its own examples, **no seconds field and no `@daily`-style macros** `[V - external]`. So
`crons.ts` ships a ~120-line parser for exactly that grammar: five space-separated fields, each
`*`, `N`, `A-B`, `A-B/S`, `*/S` or a comma-list of those, evaluated in the **server's local
timezone** (the tool says "local time", and the binary and the server run in the same process
group). Anything it cannot parse yields `nextFireAtMs: null` for that entry, which means **no
deference from that entry** — an unparseable schedule must never stand supervision down.

**The delivery is no longer an assumption.** This was the package's single largest `[A]` — a design
whose strongest trigger rode on a hook payload nobody had confirmed. Read out of the shipped binary
(2.1.236) `[V - external]`: the payload `{ background_tasks, session_crons }` is spread
**unconditionally** into both the `Stop` and the `SubagentStop` hook input, and each entry is built
as `{ id, schedule: t.cron, recurring: t.recurring ?? false, prompt }`. With no crons it is `[]`,
never absent — so "field missing" is not a case the parse has to handle. The shape matches what this
section already assumed, so nothing downstream moves; only its confidence does.

**One thing the binary does that nothing here documented: `prompt` is truncated to 1000
characters** `[V - external]`. Anything that treats the recorded prompt as the agent's full
instruction — a console row, a test fixture, a diff against what was scheduled — is wrong. Treat it
as a label.

Persisting is the whole point: the binary's table is in-process, so **T3's copy is the only durable
record that a wake was ever armed.** A `nextFireAtMs` in the past with no subsequent `updatedAt`
movement is the signal that a wake was lost, and it is the strongest trigger in this design —
stronger than staleness, because it is an unmet commitment rather than an inference.

**The grace, and why it is derived rather than a constant.** An earlier revision set
`wakeGraceMs` to a flat ~90s and justified it as ">= the binary's cron jitter". That reads the wrong
half of the jitter model. The scheduler's own text: _"recurring tasks fire up to 10% of their period
late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early"_ `[V - external]`.
The 90s is the **early** direction, which can never make a healthy wake look lost; the direction
that matters is **late**, and it scales with the period. A 30-minute recurring wake can legitimately
land 3 minutes late, a 2.5-hour one a full 15. A flat 90s would fire `wake_lost` — the strongest
trigger in the design — on a thread that is merely jittered, which contradicts the whole claim that
this reactor should almost never fire on a healthy thread. So the grace comes from the recorded
entry:

```
recurring: true   ->  max(90s, min(0.10 * period, 15min))
recurring: false  ->  90s
```

Degraded states are explicit, never silent: `gate_off` when `ScheduleWakeup` reports the gate is
off, and `wake_lost` when a recorded wake did not land. Both surface on the console.

`gate_off` needs a source, because `session_crons` carries no gate status: a **`PostToolUse` hook on
`ScheduleWakeup`**, declared in the _same_ fork-built hooks object as the `Stop` callbacks, reading
the tool's own response. That is zero extra seam — the object is fork-side, so the upstream spread
does not grow — and like every other callback here it only writes to the fork store.

**The plumbing is verified; only the response body is still an assumption.** `HookCallbackMatcher`
carries an optional `matcher` string, which for `PreToolUse` / `PostToolUse` selects by tool name,
and `PostToolUseHookInput` is `BaseHookInput & { hook_event_name: "PostToolUse"; tool_name: string;
tool_input: unknown; tool_response: unknown; tool_use_id: string; duration_ms?: number }`
`[V - external]`. So `{ PostToolUse: [{ matcher: "ScheduleWakeup", hooks: [cb] }] }` reliably
delivers the tool's own response to a fork callback. What is **not** verified is the response body:
issue #42 read `ScheduleWakeupTool.call` out of the binary as `if(!zTH())return OsH("gate_off"),…`,
so the marker string is expected to be `gate_off`, but nothing has observed it on the wire
`[A — the response body]`. Spec it as a **substring probe, not a parse**: JSON-stringify
`tool_response`, and record `degraded: "gate_off"` only when the result contains `gate_off`
case-insensitively. Anything else leaves `degraded` untouched. A probe that finds nothing is the
same as no probe, which is the correct degradation — the state is dropped rather than guessed at.

**Where it renders.** `gate_off` and `wake_lost` are the two values of `record.degraded` and both
render in the console's loop-state section, in the same slot as the rate-limit hold (§8) and with
the same rule: they must read differently from "stalled". `gate_off` reads
_"Self-pacing unavailable — the agent's scheduler is switched off upstream. T3 is pacing this run."_
None of the prototypes draw this row; that is a gap in the mocks, declared here rather than
hidden (issue #125 §B10).

**Why `updatedAt` and nothing else.** `thread.activity-appended` is grouped with
`thread.message-sent` in the projection pipeline and rewrites the row with
`updatedAt: event.occurredAt`. Background subagent `task.*` events become activity appends. So on
the thread that motivated all of this — 1,358 orphaned activities after a turn closed — the
predicate stayed quiet through all of them and would have fired at ~01:07 instead of the human
typing at 04:23. It reads **a SQL projection column, not a hot stream**, which is why it is the
only trigger in the field that survives a mid-loop server restart.

**`session.status` appears nowhere in the guard table, and that is the single most important line
in the design.** The conclusion stands. The evidence under it did not, and has been re-anchored.

_What an earlier revision claimed:_ a **background subagent's** assistant message auto-opens a
synthetic turn that pins `session.status = "running"`, and **nothing closes it**. Both halves are
false. Subagent traffic opens nothing: since upstream #5219 (`a2ca89aa1`, 2026-08-06) the only
synthetic-turn creation site returns first for any assistant snapshot carrying `parent_tool_use_id`,
with a comment saying so in as many words. And four closers exist, one unconditional —
`handleResultMessage` ends in a bare `completeTurn(...)` with no `synthetic` check, which writes
`status: "ready", activeTurnId: undefined`; `sendTurn` auto-closes a stale synthetic turn on the
next user message; `handleStreamExit` and `stopSessionInternal` close on teardown. The archived
design at least carried the qualifier — `docs/coil/loop/OPTIONS.md:505`, _"nothing closes it but a
later SDK `result` or the next `sendTurn`"_ — and this package dropped it while keeping the
confidence.

_What is true, and is enough:_ a **top-level** assistant message with no `parent_tool_use_id`,
arriving with no active turn, still opens a synthetic turn; and `ProviderSessionReaper.ts` skips any
binding whose thread has `session.activeTurnId != null`. So **any** turn whose completion never
arrives pins `running` with nothing automated to clear it — only a later `result`, the user's next
message, or process exit will. That is a permanent-on-a-quiet-thread condition, and reusing
`autoResume`'s `threadIsProgressing` as a veto would deadlock on exactly the threads this feature
exists to save. Here `running` only _lengthens_ the fuse.

The #38 field evidence is not on either side of this: the fork's own capture
(`docs/coil/loop/captures/subagent-backgrounded.ndjson`) shows the post-turn traffic as `system`
messages, which never reach `handleAssistantMessage` at all `[A]`. It supports the `updatedAt`
half of the trigger, above, and nothing about turn lifecycle.

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

1. **Reserve before dispatch.** `store.recordCheckIn(...)` persists _before_ `engine.dispatch`. This
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
terminal one, and `--resume` respawn is already handled. **The firing path touches
`SDKResultSuccess`, `total_cost_usd`, `session_crons` and `raw.method` not at all, so an SDK bump
cannot break the nudge itself.** The `session_crons` read in §4 is the design's one SDK-shaped
dependency, which is why it is marked `[V - external]`: if it moves, deference degrades to the
staleness trigger and firing is untouched.

---

## 6. The check-in prompt

Resolution order: per-thread override → `<cwd>/.coil/loop-prompt.md` → built-in. `<cwd>` is
`worktreePath ?? workspaceRoot` — **worktree first**, because `resolveThreadWorkspaceCwd` returns it
first and that is the agent's real cwd. (`autoResume/Reactor.ts` has this precedence _inverted_;
copying it would silently break the stop signal on every worktree-backed thread.)

Restated **in full every time**, because a six-check-in overnight run will compact and a contract
taught once is gone by check-in four. The prompt carries, verbatim: the check-in number and budget,
the instruction not to restart from the top, the absolute interpolated path of the done-file, the
deadline, **any answers banked since the last check-in**, and the deference line, verbatim:
_"T3 checked in because no wake of yours landed. Keep scheduling your own wake-ups as normal — T3
stands by while one is pending inside this run's deadline, covers any that are lost, and enforces
the budget and deadline."_
That line resolves the real collision with the user's own `autonomous-build-loop` skill by
**composing** with its self-pacing rather than by claiming ownership of the schedule — a prompt that
claimed ownership would fight the very mechanism §1.1 and §4 defer to.

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

**A bound that cannot stop the agent is not a bound.** T3 has no write handle on the binary's cron
table, so on `spent`, deadline or disarm _while recorded crons are still pending_ the reactor does
the honest thing #42 specified: `providerService.stopSession({ threadId })`. The crons live in the
session, so ending the session ends them. Without this a self-paced run walks straight through its
own deadline — and because `CronCreate` is unbounded and `recurring` entries live seven days
(§1.1), it can keep walking for days. The bound would be advisory exactly where the spend is
unattended.

**One semantic for the master toggle, settled by review (issue #125 §A3).** Guards 1 and 2 were
described in three incompatible ways across the package — "no fiber", "stand down at next tick", and
"existing loops stop at their next check-in". Only one of them can be true at a time, and a tick
requires a fiber. The rule is:

- **The supervisor fiber always runs**, exactly as `autoResume`'s does. One tick loop, forked once at
  layer construction.
- **`COIL_LOOP_ENABLED=0` is the only thing that stops a fiber existing.** It is read at layer
  construction and never again — an env kill switch for an operator, not a product control.
- **The master toggle is a guard evaluated every tick**, and again immediately pre-dispatch so it is
  never one-tick-stale. Toggle off ⇒ nothing fires, every armed loop reports `standing_down` with
  reason `disabled`, **nothing is disarmed and nothing is stopped**. Toggle back on and the same
  loops resume with their budgets intact.

That is the semantic a kill switch has to have for a feature that spends money unattended: switching
it off must be reversible without asking the user to re-arm anything, and it must not quietly
manufacture terminal states nobody chose.

**Guards, in order.** Non-consuming skips are marked ○ — they keep budget and surface a reason.

| #   | Guard                                                                                                                                             | On fail                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `config.enabled` (env kill switch, `COIL_LOOP_ENABLED`, checked at layer construction)                                                            | no fiber forks — the **only** condition under which no fiber exists                                                                                                                                                                                                                   |
| 2   | `store.global.enabled` — re-read **every tick and again pre-dispatch**                                                                            | ○ reason `disabled`; the loop reports `standing_down` and stays armed. Nothing is disarmed, nothing is stopped                                                                                                                                                                        |
| 3   | `record.armed === true`                                                                                                                           | ○                                                                                                                                                                                                                                                                                     |
| 4   | shell is `Some`, not archived, is a supported thread                                                                                              | **disarm**                                                                                                                                                                                                                                                                            |
| 4b  | **stop conditions, swept before any ○ guard**: `now >= deadlineAtMs`, `checkInsUsed >= maxCheckIns`, sentinel present, two strikes                | **stop** — see "Why the stop sweep moved" below                                                                                                                                                                                                                                       |
| 5   | _retired._ `settledOverride !== "settled"` — see "Why guard 5 is gone" below                                                                      | —                                                                                                                                                                                                                                                                                     |
| 6   | `snoozedUntil == null \|\| <= now`                                                                                                                | ○ the only way to honour a snooze                                                                                                                                                                                                                                                     |
| 7   | `settledOverride === "active"` ⇒ nudge **then** repair pin                                                                                        | —                                                                                                                                                                                                                                                                                     |
| 8   | `!hasPendingApprovals && !hasPendingUserInput && !hasActionableProposedPlan`                                                                      | ○                                                                                                                                                                                                                                                                                     |
| 9   | `autoResumeStore.getThread(threadId).pending === null`                                                                                            | ○                                                                                                                                                                                                                                                                                     |
| 10  | `now >= record.rateLimitedUntilMs`                                                                                                                | ○                                                                                                                                                                                                                                                                                     |
| 10b | **no deferrable wake still pending** — `nextFireAtMs == null \|\| nextFireAtMs > record.deadlineAtMs \|\| now >= nextFireAtMs + wakeGrace(entry)` | ○ the deference rule — while a wake is pending _inside the loop's deadline_ the agent is pacing itself, so T3 stands by. A wake past the deadline is not deferred to: `CronCreate` is unbounded (§1.1, §4). The `now >=` is **inclusive**. Console: _"Self-pacing · next wake 02:35"_ |
| 11  | `now - lastCheckIn.firedAtMs >= config.idleMs`                                                                                                    | ○ structural floor: a tight loop stays impossible even if `updatedAt` fails to bump                                                                                                                                                                                                   |
| 12  | idle threshold met, on a freshly re-read shell                                                                                                    | ○                                                                                                                                                                                                                                                                                     |
| 13  | _moved to 4b._ Kept as a number so cited cases keep meaning                                                                                       | —                                                                                                                                                                                                                                                                                     |
| 14  | armed threads `< maxArmedThreads` — enforced in the route **and** re-checked in the tick                                                          | ○ not bypassable by hand-editing the state file                                                                                                                                                                                                                                       |

Guard 8's third clause is the one every design in the original panel missed. `Sidebar.logic.ts`
treats plan-ready as **not** pending-input, so a thread parked on an unapproved plan otherwise
passes every other blocking guard and gets pushed past the human's yes.

**Why the stop sweep moved from 13 to 4b (added by review, 2026-09-02).** Guard 13 sat _after_ the
idle guards, so a stop condition was only ever evaluated on a tick that had already decided the
thread was idle enough to nudge. Every ○ guard above it is therefore a way to walk past a deadline:
a thread that never goes idle passes 12's check never, so 13 never ran, and a self-paced run
strolled through its own deadline indefinitely — which is precisely the outcome the `stopSession`
paragraph above says must not happen. The same hole swallowed the sentinel: an agent that wrote
`.coil/loop-done` while still working was not recorded as `done` until it happened to go quiet.
Stop conditions are facts about the **run**, not about the thread's current activity, so they are
swept immediately after the shell resolves and before anything can skip. `13` is retained as a
retired number rather than reused, the same discipline TESTS.md uses for its case numbering.

**Why guard 5 is gone (added by review, 2026-09-02).** `settledOverride === "settled"` was a ○ skip,
read as "the human is done here". It has not meant that since upstream **#8600** moved settlement
server-side: `ThreadSettlementReactor` sweeps every minute and dispatches `thread.auto-settle`,
which shares `thread.settle`'s decider case and emits the same `thread.settled` event **with no
provenance marker**. Auto-settle is on by default, so a settled flag is now overwhelmingly likely to
be a timer rather than a person, and there is no discriminator to recover the difference from. The
fork has already paid for this once: `autoResume/guards.ts` removed settledness from `threadIsGone`
for exactly this reason, and its comment records that an armed week-long resume was reliably
destroyed on day 3 by a timer. Keeping guard 5 would have reproduced the bug in a worse shape — a ○
skip never stops the loop, so an auto-settled loop would sit armed and silently do nothing until its
deadline, then report `spent`. Settling is also not a one-way door: sending a turn to a settled
thread clears the override on upstream's own path. The user's opt-out is **disarm**, and the console
says so. Guard 7 (repair the `active` pin) is unaffected and stays.

Snooze is **not** in the same position and guard 6 stands: there is no auto-snooze command —
`InternalOrchestrationCommand` contains `thread.auto-settle` and no snooze counterpart `[V]` — so
`snoozedUntil` still carries a human's intent.

**Arming pins, and what that costs.** `thread.pin` is not a decoration. Its decider case emits
**companion `thread.unsettled` and `thread.unsnoozed` events**, with a comment saying so: _"Pinning
is a promotion: it clears the parked states rather than silently outranking them"_ `[V]`. Three
consequences the design has to state rather than discover:

1. **Arming a snoozed thread would silently cancel the snooze.** The route therefore returns
   `400 thread_snoozed` on an arm while `snoozedUntil > now`. Unsnooze first; that is a decision the
   human makes, not one a supervisor makes for them.
2. **Arming a settled thread unsettles it, and that is correct** — the human asked for the thread to
   run, which is the definition of a promotion.
3. **Disarm unpins only what the loop pinned.** `pinnedByLoop` is recorded at arm time (`true` only
   when `pinnedAt` was null before the arm), and disarm dispatches `thread.unpin` only when it is
   `true`. Without it, disarming a loop on a thread the user had pinned themselves would remove
   their pin, and nothing would record that it had ever been theirs.

There is **no actor check** on any of this: orchestration commands carry no actor field, `dispatch`
takes only an optional descriptive `origin`, and the decider's `thread.pin` case guards on archival
alone `[V]`. A fork reactor may dispatch `thread.pin` exactly as it dispatches `thread.turn.start`.
The corollary is that nothing upstream will stop the fork from doing the wrong thing here, which is
why the three rules above are rules rather than notes.

---

## 8. Not fighting auto-resume, and surviving limits

Guard 9 is one direction. The other direction needs its own fiber, because `autoResume`'s scheduler
only arms when _its_ per-thread `enabled` is true — so on a thread where the user turned auto-resume
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
the console says _"Held — usage limit until 08:22"_, which must read differently from _"stalled"_.
One of the two failures on the original night was a human unable to tell these apart.

---

## 9. The question channel — the genuinely new part

### 9.1 The problem, precisely

`AskUserQuestion` already exists and already works: the adapter intercepts it in `canUseTool`,
emits `user-input.requested` with a structured `{ id, header, question, options[], multiSelect }`
payload, and the projection surfaces it as `hasPendingUserInput`. It renders natively.

And it **blocks**: `const answers = yield* Deferred.await(answersDeferred)`.

An agent that hits a genuine fork in the road at 01:00 and asks about it _correctly_ stops working
until 09:00. Guard 8 then refuses to nudge it — also correctly, because pushing past a pending
decision is worse. The loop and the question channel are in direct tension, and no tuning resolves
it.

### 9.1b And a question can now be _voided_ without anyone seeing it

Upstream **#5127** (`3b54a2a57`, 2026-08-15) made session teardown settle every pending
user-input as an **empty answer** so the thread can settle:

```ts
for (const pending of [...context.pendingUserInputs.values()]) {
  yield * pending.cancel; // Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers)
}
```

So a question nobody answered does not merely hang — on a session stop the handler unparks with
`{}`, the tool call is denied, and the session tears down. What survives is the runtime's
`user-input.resolved` carrying empty answers: the human never sees the question, and
`hasPendingUserInput` reads false afterwards, so a voided question is indistinguishable from an
answered one.

Two design consequences:

- The console **cannot derive its blocking list from `hasPendingUserInput` alone.** The fork must
  record the `user-input.requested` event when it happens, and mark it `voided` if a
  `user-input.resolved` arrives with an empty answer during teardown rather than from a human.
- It is a second, independent argument for `raise_blocker`: a deferred blocker is durable
  fork-side state and cannot be discarded by a session stop.

### 9.1c And there is now a _second_ blocking dialog, which the loop can trigger itself

Upstream **#8144** (`c7222ca4d`, 2026-08-25) added `onUserDialog` with
`supportedDialogKinds: ["resume_return"]` to the same `queryOptions` object phase 1 edits `[V]` —
present in the fork's tree today. It routes into the same blocking `Deferred` as `AskUserQuestion`,
and it fires **on session resume**. So the loop's own nudge, landing on a thread whose session was
torn down, can manufacture a pending user-input that guard 8 then treats as a hard skip.

The failure is not that the loop pushes past a human — guard 8 correctly refuses — it is that the
loop can **cause** the thing that parks it, silently, and then sit at zero spend until its deadline
reports `spent`. Three rules, and no new guard:

1. **Guard 8 does not change.** A pending input is a pending input whatever produced it; nudging
   past one is worse than waiting.
2. **The fork's `user-input.requested` record (§9.1b) carries the dialog kind**, so the console can
   say _"waiting on a session-resume confirmation since 01:04"_ rather than showing an unexplained
   idle loop. A `resume_return` park that the loop caused must be legible as exactly that.
3. **It resolves through the deadline, and that is acceptable.** A loop parked on a dialog spends
   nothing and ends `spent`, distinctly coloured and distinctly worded, with the reason on the
   console. That is the correct outcome for "a human is needed and was not there".

Whether this is common enough to want a `resume_return` auto-answer is a question for the first
dogfooding run, not for the design. It is deliberately **not** answered here: auto-answering a
dialog the human never saw is precisely the class of move that made the console worth building.

### 9.2 The fix — a second, non-blocking channel

A fork-owned MCP tool, `raise_blocker`, that **records and returns immediately**:

```
raise_blocker({ question, options?, context? }) -> { id, "recorded" }
```

The agent parks _that branch of work_ and continues with something else. The answer is delivered on
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

| Source                                           | Needs model cooperation? | Where it comes from             |
| ------------------------------------------------ | ------------------------ | ------------------------------- |
| Blocking: approvals, pending input, plan-ready   | **no**                   | SQL columns on the thread shell |
| Loop-authored: skip reasons, stop reason, budget | **no**                   | fork-owned store                |
| Deferred blockers                                | yes                      | `raise_blocker`                 |

A model that never calls `raise_blocker` still produces a correct console — it just has fewer rows.
It degrades to _"the loop is spent, and nothing is waiting on you"_, which is true and useful,
rather than to silence. **That is the acceptance test**, and it is why the prototype renders the
empty state explicitly.

### 9.4 Two more tools, both small

- `loop_status()` → the agent's own budget: _"check-in 4 of 6, 51 minutes to deadline"_. Lets a
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
GET  /api/coil/loop/settings        -> the global block: enabled + defaults + armed count
POST /api/coil/loop/settings        -> write the master toggle and the defaults
```

**The settings pair is new, added by review (issue #125 §B7), and it moves phase.** `store.global.enabled`
was the headline kill switch with no data model, no route and no test — and the sequencing
consequence was worse than the omission: phase 2 shipped "default off behind the master toggle"
while only phase 4 could flip it, so phases 2 and 3 were **unswitchable as ordered**. §3 now carries
`LoopGlobalSettings`, and **the settings routes ship in phase 2 with the reactor**. Phase 4 adds the
_UI_ over a route that already works, which is also how it should have been sequenced anyway: a
control surface built on a live endpoint is testable, one built on a stub is not.

Operate scope, not read — these mutate scheduling. Upstream's private scope-auth path currently
exists as **two independent fork mirrors** — `authenticateWithOperateScope` in `autoResume/http.ts`
(scope hardcoded) and `authenticateWithScope(scope)` in `webPush/http.ts` (parameterised) — and only
one is in the ledger; this feature moves the general form to a shared `coil/http/auth.ts` rather
than becoming a third.

**Correction to phase 0's brief: the webPush form is _not_ strictly more general.** It is
parameterised on scope and returns the session, which `autoResume`'s is not — but it calls
`failEnvironmentAuthInvalid` with **one** argument, where `autoResume`'s passes
`EnvironmentAuth.serverAuthDpopFailureReason(error)` as the second. That second argument is the
whole point of `3bdf109e2`, which landed on 2026-09-02 precisely because the stale one-argument call
compiled and drifted silently: a relay client whose DPoP proof failed got a precise reason from
every environment endpoint except this one. Promoting webPush's body verbatim would **re-introduce
the bug it just fixed, in a shared helper, for all three callers**. The promoted
`authenticateWithScope(scope)` must be the union of both: parameterised on scope, returning the
session, **and** passing the DPoP failure reason.

---

## 11. Seam cost

| File                                                      | Delta    | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/coil/index.ts`                           | +~6      | **fork-owned, churn 0** — store, reactor, routes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`  | **±0**   | existing row (+10/−6, churn **2**, risk **32**) rewritten in place — **delta 0**: `<AutoResumeOverlay threadRef={threadRef} />` → `<ThreadCoilOverlay threadRef={threadRef} />`, one JSX element swapped for one JSX element inside the fragment the fork already added. The aggregator then hosts both. Genuinely delta-zero, and every future per-thread fork surface is free forever. Re-measured 2026-09-02: churn fell 4 → 2, so the row is **cheaper** than the docs said, not dearer. |
| `apps/server/src/server.ts`                               | **0**    | already has its 3-line row                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/contracts`                                      | **0**    | activity `kind` is an open `TrimmedNonEmptyString`, payload is `Schema.Unknown`                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Sidebar.tsx` / `Sidebar.logic.ts`                        | **0**    | a loop is a **pinned thread** — `thread.pin` already exists                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`        | **+1**   | **new row.** A single spread into the existing `queryOptions` object: `...(loop ? { hooks: loop.claudeHooks(threadId) } : {})`. `options.hooks` is set nowhere in this repo today, so this is the first subscription to a 30-event surface — though the neighbourhood is no longer empty: #4466 sets `settings: { disableAllHooks: true }` on the capability probe, so upstream has begun touching hook-adjacent config.                                                                     |
| `apps/web/src/components/settings/settingsSearch.ts`      | **~+13** | **new row** (phase 4) — the `SettingsPath` union, a `SETTINGS_SECTION_LABELS` entry, and 2 `SETTINGS_SEARCH_ITEMS`. Measured, not estimated: applying that recipe to the real file and diffing gives **+13**, because each search item is a 5–6 line object literal (37 items span 202 lines); upstream's own +26 on this file decomposes the same way, as 1 union + 1 label + 4 items. Three items is ~+19. Append-ordered arrays, additive.                                                |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx` | **+2**   | **new row** (phase 4) — the icon import and its `SETTINGS_SECTION_ICONS` entry.                                                                                                                                                                                                                                                                                                                                                                                                              |

| `apps/server/src/mcp/McpHttpServer.ts` | **+2/−1** | **new row** (phase 5) — one import of the fork's `LoopToolkitRegistrationLive`, and the terminal `export const layer = PreviewToolkitRegistrationLive.pipe(…)` wrapped in a `Layer.mergeAll`. Churn **2**, risk **6**. Measured, not estimated — see "Phase 5, measured" below. |

**The `ClaudeAdapter` row is new since the first draft** and it is the cost of the deference rule.
It is worth arguing rather than waving through: the file is churn-**23** and ~4.8k lines (4,820 at
merge-base `941acb4f9`), which is the most expensive kind of row this fork can take. Three things
keep it cheap:

1. **It is one line, and it is additive.** A spread into an object literal alongside the existing
   `mcpServers` spread. Every line of logic lives fork-side in `coil/loop/crons.ts`.
2. **It is a read.** No `allowedTools`, no `disallowedTools`, no permission change — the hook
   callbacks observe `input.session_crons` and write to a fork-owned store. It cannot change what
   the model is allowed to do.
3. **It fails safe.** If upstream renames or removes the hook surface, the spread stops compiling
   (a type error, not a silent drift), and if the hook simply never fires the loop degrades to the
   staleness trigger it had before — which is the behaviour of the previous draft.

If that row is unacceptable, the fallback is the pure-staleness trigger with a longer `idleMs` to
reduce double-firing. It is strictly worse — it cannot tell "the agent is pacing itself" from "the
agent has stopped" — but it costs zero upstream lines, so it is a legitimate zero-seam fallback.

The settings surface was the one open bill. It is now **decided — see PLAN §6 and UPSTREAM-DELTA
§4.1** — and priced as the two rows in the table above: **phase 4 is 2 new rows, ~+15 lines.**
An earlier revision said ~+6, which was about a third of the real figure; the row count was right
and is unchanged, only the lines move.

- **Own section** (`/settings/loops`) — the `SettingsPath` union + `SETTINGS_SECTION_LABELS` +
  2 `SETTINGS_SEARCH_ITEMS` in `settingsSearch.ts` (churn 14, ~+13), the `SETTINGS_SECTION_ICONS`
  entry in `SettingsSidebarNav.tsx` (+2), and a new fork-owned route file. The generated
  `routeTree.gen.ts` is not part of the cost: it is regenerated, not merged. `settingsSearch.ts`'s
  append-ordered arrays are structurally the same add/add conflict shape as issue #29.
- **Ride inside General** — cheaper, but buries a feature that owns unattended spend.

Recommendation, and the decision taken: **own section.** A feature that can spend money while you
sleep should be findable by name.

`searchableSetting()` registration is **not** skipped: `SettingsSearchItemId` is derived from
`SETTINGS_SEARCH_ITEMS`, so the fork's own rows become searchable the moment the items are added —
which is part of what the `settingsSearch.ts` row buys.

**Both settings rows are mandatory, not a style choice** `[V]`. `SETTINGS_SECTION_LABELS` in
`settingsSearch.ts` and `SETTINGS_SECTION_ICONS` in `SettingsSidebarNav.tsx` are both
`Readonly<Record<SettingsPath, …>>`, and `SETTINGS_NAV_ITEMS` is _derived_ by mapping the label
record's keys. So adding `"/settings/loops"` to the `SettingsPath` union without also adding a label
**and** an icon is a type error. There is no cheaper additive shape.

Their price has risen since the estimate and should be re-read before phase 4 starts: measured at
merge-base `941acb4f9`, `settingsSearch.ts` is churn **24** (was 14) and `SettingsSidebarNav.tsx`
churn **19**. At ~+13 and +2 lines that is risk ~312 and ~38 — an order of magnitude above phase 1's
adapter row, and phase 4's own upstream neighbourhood keeps moving (`a19f01fc1`, 2026-09-02, adds
another `settingsSearch.ts` entry). D10 stands; the number is simply larger than it was.

**The zero-row fallback, recorded because it now exists in the tree.** `/settings/diagnostics` is a
real, navigable settings route that is **not** a `SettingsPath` member — `SETTINGS_BREADCRUMB_LABELS`
patches its label in by hand `[V]`. So a fork-owned `settings.loops.tsx` reached from the console
rather than from the sidebar costs **zero upstream rows**, at the price of not being findable by
name in the nav or in settings search. That is exactly the trade D10 rejected ("a feature that can
spend money while you sleep should be findable by name") and the decision does not change — but if
the two rows are ever refused at review, this is the fallback, and it is upstream's own pattern
rather than an invention.

**Phase 5, measured (issue #125 asked; PLAN had it as `0–3 rows [A]`).** Three paths, all measured
against `941acb4f9`:

| Path                                       | Upstream edits                                                                                                                                                                               | Rows  | Risk |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| **A** — a gated `"loop"` capability        | `McpInvocationContext.ts` +1/−1 (churn 1) · `McpSessionRegistry.ts` +1/−1 (churn 1) · **`packages/contracts/src/previewAutomation.ts`** +1/−1 (churn 3) · `McpHttpServer.ts` +2/−1 (churn 2) | **4** | 16   |
| **B** — ungated toolkit **(the decision)** | `McpHttpServer.ts` +2/−1 (churn 2)                                                                                                                                                           | **1** | 6    |
| **C** — register from `coil/index.ts`      | none                                                                                                                                                                                         | **0** | 0    |

**Path B is the decision.** Path A is rejected on two counts and neither is the row count: it forces
an edit to `packages/contracts` (`PreviewAutomationUnavailableError`'s `capability` is a runtime
`Schema.Literal("preview")`, so widening the TypeScript union alone does not typecheck), which
breaks **D12**; and it makes a tool named `raise_blocker` fail with an error class named
`PreviewAutomationUnavailableError`. The capability gate buys nothing here in exchange: nothing at
registration or dispatch consults `capabilities` — `requireMcpCapability` is one voluntary line
inside one handler helper, and the credential is **already per-thread and already all-or-nothing**
`[V]`. The loop toolkit's real gate is `store.global.enabled` plus the per-thread armed record, both
of which it must check anyway.

**Try Path C first, and fall back to B without ceremony.** `McpServer.toolkit(t)` is
`Layer.effectDiscard(registerToolkit(t)).pipe(Layer.provide(McpServer.layer))` and `layerHttp`
provides the _same_ layer value, so Effect's MemoMap should hand both the one `McpServer` instance —
the identical memoisation property `coil/index.ts` already depends on and `autoResume/sharing.test.ts`
already pins. The unresolved blocker is typed, not behavioural: a declared `McpInvocationContext`
dependency leaks into the layer's `R`, which today is discharged only inside the non-exported
`McpTransportLive`. Upstream's own `registerPreviewSnapshot` shows the way out —
`Effect.withFiber` + `Context.getUnsafe(fiber.context, McpInvocationContext)` — which keeps `R`
empty. **This has not been typechecked.** Attempt it, give it one focused session, and take Path B
the moment it fights back; the difference is one row at risk 6.

**A coupling phase 5 inherits and cannot fix.** The MCP credential is minted only when
`enableAgentBrowserAccess` is true (`ProviderService.prepareMcpSession` revokes it otherwise) `[V]`.
So a user who turns **Settings → Integrations → Agent browser access** off loses `raise_blocker`,
`loop_status` and `loop_done` along with it, with no loop-shaped explanation. The console must
render that as a named degraded state, not as an empty blocker list.

---

## 12. Restart safety

State is durable JSON; the trigger is a SQL column. A reboot at 3am loses nothing: armed threads
stay armed, and budgets, deadlines, strikes, `armedAtMs` and `rateLimitedUntilMs` all survive.
`processStartedAtMs` stops the first post-boot tick from firing everything at once.

This is the property **no event-edge design has**, because both `providerService.streamEvents` and
`engine.streamDomainEvents` are hot-only. It is also the half of #38 that upstream's
`ThreadBackgroundLiveness` explicitly does not provide — its own module doc says _"no persistence,
no migration. After a server restart the registry is empty."_

**Upstream has started work in this area and it does not take the premise away — `5b7d72aad`
(#9167, 2026-09-02), arriving on the next sync.** It continues _active threads_ across a server
restart: before a self-update it stamps the running `activeTurnId` into
`provider_session_runtime.runtime_payload_json.continueAfterServerUpdate`, and on the next cold
start it re-establishes the binding and sends a fresh turn (`"Continue where you left off."`, or
promptless where the adapter supports it). Four reasons D1's durability argument survives intact,
each from the commit `[V]`:

1. **It marks only threads with `session.status === "running" && activeTurnId !== null`.** A thread
   waiting on a scheduled wake is neither. **A pending wake is never marked, so it is never
   continued** — which is the exact gap this feature exists to cover.
2. **It is opt-in and ships off**: `continueThreadsAfterServerUpdate` decodes to `false`.
3. **It only writes the marker on the intentional self-update path.** A crash, an OOM, a `kill`, a
   machine reboot — the cases a supervisor is for — write nothing and behave exactly as before,
   settling the thread with _"Provider session did not survive a server restart."_
4. **It does not continue the interrupted turn.** `activeTurnId` is nulled and a new turn is
   started, so a partially-finished turn is lost either way.

What it does introduce is a **double-fire window**, and it is worth naming precisely because it is
the kind of thing that is invisible until 3am. Reconciliation dispatches `session.status: "starting",
activeTurnId: null` synchronously at startup, but the actual `sendTurn` is parked behind server
activation — so there is a real interval in which a continued thread looks idle, with no error, and
nothing takes a lease. **This design already covers it, by two independent mechanisms**:
`busyTurn` counts `status === "starting"` (§4), so the fuse is `busyIdleMs`; and
`processStartedAtMs` floors the idle clock at process start, so no armed thread can fire for at
least `idleMs` after boot regardless. Neither was added for this, which is the reassuring part.
TESTS case 130b pins it. If a stronger guard is ever wanted, the honest signal is the marker itself —
non-null means upstream has claimed the thread — but reading `provider_session_runtime` from a fork
reactor would be a new coupling to an upstream table, and the two mechanisms above cost nothing.

---

## 13. What this honestly does not solve

- **A single silent tool call longer than `busyIdleMs` reads as idle**, and the check-in is then
  absorbed as a steer into the live turn with no visible turn boundary. `busyIdleMs` is a tunable
  magic number, not a solution.
- **Without an adopted done-file, `done` is unreachable and every run ends `spent`.** That is why
  the path is interpolated absolute, the contract restated every check-in, and `spent` visually
  distinct.
- **Cost is not metered in dollars.** Budget is check-ins and wall-clock. `total_cost_usd` flows
  from `SDKResultSuccess`, and the adapter does stamp it onto `turn.completed.totalCostUsd` — but
  nothing downstream aggregates it, and its per-turn vs session-accumulated semantics are unmeasured
  `[A]`. The SDK's documented use describes it as accumulated **by the session**, so summing per
  turn would inflate quadratically and a "$25 cap" would trip around iteration 6 of a $4 run. A ledger whose selling point is trust
  cannot rest on an unverified number. Revisit only after measuring it.
- **Bounding a self-paced run means ending its session.** T3 cannot delete an entry from the
  binary's in-process cron table, so a `spent`, deadline or disarm on a thread with pending wakes is
  enforced with `providerService.stopSession` (§7). That is honest but blunt: it takes any live
  background work in that session with it. There is no finer instrument until `cron_durable` or a
  cancel API exists.
- **A derailed agent still burns budget.** Strikes catch the _dead_ failure, not the _wrong-work_
  failure. Nothing here reads what the agent actually did.
