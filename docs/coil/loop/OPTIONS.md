# Loop Watch — the four designs considered

_Generated 2026-08-02. Each was designed independently from the same verified ground truth, then scored by three adversarial lenses (upstream-conflict steward, adversarial SRE, the user)._

---

## Deadman

**Average score: 0/10**

> A deadman's switch on `projection_threads.updated_at`: a second fork-owned reactor, shaped exactly like `autoResume/`, that nudges an explicitly-armed thread back to life after N minutes of true silence, stops on a `.t3x/loop-done` sentinel the agent writes with the Write tool, and can never fire more than 6 times per arm.

### Core mechanism

`apps/server/src/coil/loop/Reactor.ts` is `AutoResumeReactorLive`'s twin: `Layer.effectDiscard(makeSupervisor)` with **one** `Effect.forkScoped(processTick.pipe(Effect.catchCause(log), Effect.delay(Duration.millis(config.pollMs)), Effect.forever))` — the same self-starting shape as `apps/server/src/coil/autoResume/Reactor.ts:279-287`, so it needs zero `server.ts` and zero `serverRuntimeStartup.ts` edits. It registers in `apps/server/src/coil/index.ts` (churn 0) by adding one entry to `CoilLayerLive` (index.ts:71) and one to `CoilRoutesLive` (index.ts:100), with `LoopStoreLive` defined at module scope so the reactor and the route share one memoised store — the exact pattern `apps/server/src/coil/index.ts:80-98` documents and `autoResume/sharing.test.ts` pins.

There is no thread enumeration and no `getSnapshot()`. The durable JSON store (`t3x-loop.json` in `ServerConfig.stateDir`, `SynchronizedRef` + `writeFileStringAtomically`, copied from `autoResume/state.ts`) holds the set of **armed** thread ids. A tick iterates only those — typically one — and for each does exactly two single-row reads: `snapshotQuery.getThreadShellById(threadId)` (`apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:161-163`, the read `webPush/Reactor.ts:80` already uses) plus `getProjectShellById(shell.projectId)` for `workspaceRoot`. Per-tick cost with nothing armed is zero SQL.

The trigger is ground-truth fact #5 and nothing else: `now - Date.parse(shell.updatedAt) >= threshold`. Because `thread.activity-appended` bumps `updatedAt` in both `ProjectionPipeline.ts:796-808` and `projector.ts:747-750`, and background subagent `task.started`/`task.progress`/`task.completed` become activity appends (`ProviderRuntimeIngestion.ts:489,542`), this predicate is subagent-aware for free: it stayed quiet through all 1,358 activities of thread 3a85bdd3 and would have fired at the start of the 3h31m silence. No open-task set, no TTL, no `Stop` hook, no `ClaudeAdapter.ts` edit.

Firing is one `engine.dispatch({type:"thread.turn.start", commandId: CommandId.make(`t3x-loop:${uuid}`), threadId, message:{messageId: MessageId.make(`t3x-loop:${uuid}`), role:"user", text, attachments:[]}, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, createdAt})` — byte-for-byte `autoResume/Reactor.ts:109-122`, i.e. an ordinary user turn through the SDK session. It is bracketed by two `thread.activity.append` breadcrumbs (`t3x.loop.nudged`, later `t3x.loop.stopped`), and — only when the pre-dispatch shell showed `settledOverride === "active"` — followed by one `{type:"thread.unsettle", reason:"user"}` to restore the keep-active pin that `decider.ts:829` just destroyed. `decider.ts:509-534` always emits an event for `thread.unsettle`, so that repair dispatch can never hit the engine's zero-event rejection.

### Trigger rule

Evaluated per armed thread, per tick, against a freshly-read `OrchestrationThreadShell` — never against state captured earlier in the tick.

`idleMs = now - Date.parse(shell.updatedAt)`

`threshold = (shell.session?.status === "running" || shell.session?.status === "starting" || shell.latestTurn?.state === "running") ? config.busyIdleMs : config.idleMs`

Fire when `idleMs >= threshold`. Defaults: `idleMs` 15 min (`T3X_LOOP_IDLE_MS`), `busyIdleMs` 45 min (`T3X_LOOP_BUSY_IDLE_MS`), `pollMs` 60 s.

Exact fields read: `shell.updatedAt`, `shell.session.status`, `shell.latestTurn.state`. That is the whole trigger.

The two-threshold split is the deliberate answer to traps #7 and #8. I do **not** reuse `autoResume/guards.ts:106-110 threadIsProgressing` as a veto — a background subagent's assistant message auto-opens a synthetic turn (`ClaudeAdapter.ts:2469-2486`) that nothing closes, so `session.status` is stuck `"running"` forever on exactly the issue-38 threads and a "don't fire while progressing" guard would deadlock. Instead `status === "running"` only _lengthens_ the fuse. That simultaneously buys the protection a veto was supposed to give: a legitimately-working turn (a 20-minute `pnpm test`, which emits `tool.started` then nothing until `tool.completed`) gets 45 minutes of grace before a nudge would be absorbed as a steer (`ClaudeAdapter.ts:3729-3737`). 45 minutes of total silence on a "running" turn is a genuine stall by any reading.

Rejected alternative: edge-detecting `projectThreadAwareness` → `"completed"` off `engine.streamDomainEvents`, the way `webPush/Reactor.ts` does. It cannot express "has been silent for N minutes" (which is the actual bug), it is hot-only so a server restart loses the edge, and on a stuck synthetic turn the phase never reaches `completed` at all.

### Stop condition

Four independent stops. Any one halts the loop, disarms the thread in the store, and appends a `t3x.loop.stopped` activity. Disarming requires a human to re-arm — the loop never re-arms itself.

**1. The DONE sentinel (the primary, CLI-compatible stop).** The nudge text instructs the agent, in plain English, that when the work is finished or it is blocked on the human it must write `<cwd>/.t3x/loop-done` containing one line of reason. That is an ordinary `Write` tool call — no bespoke tool, works identically under `claude` in a terminal. `sentinel.ts` stats `${shell.worktreePath}/.t3x/loop-done` and `${project.workspaceRoot}/.t3x/loop-done` (both, most-recent mtime wins, because the agent's cwd is the worktree when one exists) and honours it only when `mtime > record.armedAtMs`. The mtime gate is what makes last night's sentinel harmless tonight — and it means **the supervisor never writes to the user's filesystem**, which is the property that makes it safe to point at any repo. Any stat error resolves to "no sentinel" (fail toward continuing, which is bounded by stops 2-4). Precedent: the fork already reads `<workspaceRoot>/.t3x/resume-prompt.md` (`autoResume/config.ts:83`), so "a file in `.t3x/`" is an established contract, and it lines up with the user's own `.loop/state.json` + `GOALS.md` convention.

**2. The budget.** `record.nudgeCount >= config.maxNudges` (default 6, `T3X_LOOP_MAX_NUDGES`). The counter is per-_arm_, not a rolling 24h window — deliberately simpler than `autoResume`'s `firedAtMs[]` history, because the semantics wanted here are "this night's run gets six nudges", not "ten per day". It resets to 0 only on re-arm and on human takeover.

**3. Strikes — the anti-zombie stop.** At fire time the record stores `lastNudge = {createdAtIso, firedAtMs}`. At the _next_ fire decision, `workedMs = Date.parse(shell.updatedAt) - lastNudge.firedAtMs`. If `workedMs < config.productiveMs` (default 2 min) the previous nudge produced essentially nothing — the model answered "ok" and stopped — and that is a strike; otherwise strikes reset to 0. `strikes >= 2` (`T3X_LOOP_MAX_STRIKES`) stops with reason `stalled`. This is the stop that catches the genuinely dead session, and it costs one more field on `updatedAt`. Two dead nudges is the ceiling on wasted turns for a thread that will never make progress again.

**4. Human takeover.** `shell.latestUserMessageAt > record.lastNudge.createdAtIso` means a user message strictly newer than our own nudge exists. `latestUserMessageAt` is `max(message.createdAt)` over user messages (`ProjectionPipeline.ts:564-570`) and our nudge carries the `createdAt` we minted, so this is an exact string comparison with no epsilon. It is not a stop but a **reset**: `nudgeCount = 0`, `strikes = 0`, `lastNudge = null`, `armedAtMs = now`. The human came back; they get a fresh budget without touching the toggle.

Deliberately **not** a stop condition: scanning the last assistant message for a `DONE` marker. It needs `getThreadDetailById` plus text matching, and the cost of the agent forgetting the file is exactly one turn out of six. Skipped in v1.

### Settings surface

**Global**, and it lives on the server, not in client settings. `apps/web/src/routes/settings.beta.tsx` (11 lines, churn **1** — the cheapest settings mount in the tree) changes `<BetaSettingsPanel />` to `<><BetaSettingsPanel /><LoopBetaSection /></>` plus one import: +3 fork lines, risk ~3. `LoopBetaSection` is fork-owned (`apps/web/src/coil/LoopBetaSection.tsx`) and imports `SettingsPageContainer`/`SettingsSection`/`SettingsRow` from `~/components/settings/settingsLayout` (churn 6, not a seam — free to import), rendering one `SettingsSection title="Loop supervisor (beta)"` with a `control={<Switch checked onCheckedChange aria-label="Enable the loop supervisor beta" />}` row plus a read-only "N threads armed" status.

It does **not** use `useClientSettings`. That is a correctness argument, not just a seam argument: the reactor runs server-side and cannot see a browser-persisted client setting at all. The flag lives in the fork's `t3x-loop.json` behind `GET/POST /api/coil/loop`, so `packages/contracts/src/settings.ts` (churn 18, risk 162, and a _persisted_ schema where a bad add is a data problem) is never touched, and the toggle is correctly global across every device pointed at that server.

Global default is **false** — it is beta and it spends tokens. Flipping it off stops every armed thread within one 60 s tick; arming state is preserved so flipping it back on resumes supervision.

**Per-thread** arming is not in Settings — it is the pill in the thread view, because arming is a per-run decision made at the moment you walk away from a thread. `searchableSetting()` is skipped (its id type is closed to the upstream catalog); the row passes plain `id`/`title`, exactly as the fork's existing `notifyOnNeedsInput` row does.

### Seam cost

Measured against merge-base `64bf01619` with SEAMS.md's own recipe (`MBTS=$(git show -s --format=%ct $MB); git log --oneline --since="@$((MBTS-60*86400))" $MB -- <path> | wc -l`).

**1. `apps/web/src/routes/settings.beta.tsx` — churn 1, +3 fork lines → risk 3. NEW seam row 35.** One import of `LoopBetaSection`, and `SettingsBetaRoute`'s single-expression return becomes a fragment with two children. This is the only new row the design creates, and at risk 3 it is roughly two orders of magnitude cheaper than the alternative (`SettingsPanels.tsx`, churn 18, already at risk 1044; a second 45-line row there costs 810). SEAMS.md's tripwire ("before adding row 35, re-isolate something instead") is satisfied in the same PR by item 2, which re-isolates the per-thread mount so the fork's second-most-touched web seam stops growing per feature. The row must be added to SEAMS.md in the same commit per SEAMS.md:24-27.

**2. `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — churn 5, EXISTING row (fork Δ +10/-6, risk 80) → risk 80, delta 0.** Line 18 `import { AutoResumeOverlay } from "../coil/AutoResumeOverlay";` and line 92 `<AutoResumeOverlay threadRef={threadRef} />` are rewritten in place to `ThreadCoilOverlay`. Same line count, same fork Δ, same risk. The naive alternative (mount `<LoopPill>` as a third sibling) would have been +2 lines × churn 5 = +10 risk and +2 more for every future per-thread feature; this is strictly better and permanently caps that row.

**3. `apps/server/src/coil/index.ts` — FORK-OWNED, churn 0 → risk 0.** ~12 lines: `LOOP_STATE_FILENAME`, a module-scope `LoopStoreLive`, `LoopReactorLive.pipe(Layer.provide(Layer.mergeAll(LoopStoreLive, AutoResumeStoreLive)))` into `CoilLayerLive`, `loopRouteLayer.pipe(Layer.provide(LoopStoreLive))` into `CoilRoutesLive`.

**4. `apps/server/src/server.ts` — UNTOUCHED.** The 3-line seam at 59/224/422 (churn 29, risk 87) does not move. Same for `serverRuntimeStartup.ts` (risk 192), `ws.ts` (churn 41), `persistence/Migrations.ts` (churn 6), `packages/contracts/src/orchestration.ts` (churn 12 — no new command literal, so upstream #5123's `thread.wake-if-idle` and #3164's `condition` field land with zero collision), `packages/contracts/src/settings.ts` (churn 18), `ClaudeAdapter.ts` (churn 12 — no `options.hooks`), `AppSidebarLayout.tsx` (churn 15), `SidebarV2.tsx` (33), `Sidebar.tsx` (32), `ChatView.tsx` (63), `routeTree.gen.ts` (5 — no new route file), `settingsSearch.ts` (1 — `searchableSetting` skipped).

**5. `docs/coil/SEAMS.md`** — fork-owned; add row 35 and update the header totals. No risk.

**TOTAL NEW UPSTREAM RISK: 3.** One new seam row, three lines, in an eleven-line churn-1 file.

### Claude Code CLI compatibility

Full, by construction, on both halves of the loop.

**The nudge is an ordinary user turn.** `thread.turn.start` with `role:"user"` is byte-for-byte what a keystroke produces — `autoResume/Reactor.ts:100-123` documents this and it has been running in this fork since #9. It goes through the same `query({prompt: AsyncIterable<SDKUserMessage>})` streaming-input session with `--resume` and provider respawn already handled by `ClaudeAdapter`. There is no `ScheduleWakeup`, no self-invocation, no bespoke tool, no `options.hooks`, and no MCP dependency. The same prompt pasted into `claude` in a terminal produces the same behaviour.

**The stop signal is a file the agent writes with `Write`.** `.t3x/loop-done` is the most CLI-native contract available: every Claude harness has a file-write tool, it survives context compaction (unlike a message marker), it survives a session restart, a human can create it (`touch .t3x/loop-done`) or defeat it (`rm`), and it is greppable after the fact. It deliberately keys off the same habit the user's own `autonomous-build-loop` skill already has — `.loop/state.json`, `GOALS.md`, `iter-NNN.md` — rather than inventing a protocol, and it follows the fork's own established precedent of reading `<workspaceRoot>/.t3x/resume-prompt.md` (`autoResume/config.ts:83`).

**The nudge text is user-owned and CLI-portable.** Resolution order mirrors `resolveResumePrompt`: per-thread override from the store → `<cwd>/.t3x/loop-prompt.md` (committable, so the contract travels with the repo and works for a bare CLI run too) → the built-in default. A user already running `/loop` can point the file at their own protocol.

**Zero SDK-version coupling.** The trigger reads one projection column. Nothing in the design touches `@anthropic-ai/claude-agent-sdk` types, `SDKResultSuccess`, `StopHookInput.background_tasks`, `session_crons`, `task_updated`, or `subagent_type`. An SDK bump cannot break it. The `Stop`/`SubagentStop` hook roster stays available as a strictly-optional follow-up if `updatedAt` ever proves too coarse — but it would cost a fresh edit to `ClaudeAdapter.ts` (churn 12) and is not needed for issue #38.

### Why it wins

It fixes the actual night, and it is the smallest thing that does.

On issue #38's own timeline: turn `completed` at 00:19:19Z, activities streaming until 00:52, then 3h31m of silence. `updatedAt` last moves at ~00:52 (every one of those 1,358 subagent activities bumped it via `ProjectionPipeline.ts:796-808`). Deadman fires at 01:37 on the busy path — the thread's synthetic turn almost certainly left `session.status = "running"` — instead of the human typing "You stopped again" at 04:23. Roughly 2h45m recovered on stall one and over 6h on stall two, using 2 of a 6-nudge budget. The user sleeps.

It is one poll fiber, one JSON file, one raw route, and one pure `decide` function. Every hard part is already solved in-tree and copied rather than invented: the self-starting reactor shape, the `SynchronizedRef` + atomic-write store with its three-way boot classification, the `Layer.unwrap` route trick that keeps the store requirement out of upstream's `makeRoutesLayer` signature, the memoised module-scope store identity, the `authenticateWithOperateScope` mirror, and the web fetch/poll/optimistic-write component. A reviewer who knows `autoResume/` can read this in one sitting, and the diff is mostly recognisable.

Three lines of upstream edit, total risk 3, one new SEAMS.md row — and the PR _shrinks_ the fork's per-thread web seam by re-isolating it behind `ThreadCoilOverlay`, so the tripwire is paid down rather than tripped. No contracts change, no migration, no `ws.ts`, no `ClaudeAdapter.ts`, no sidebar, no new route file, no `routeTree.gen.ts` churn. Upstream #5123's `thread.wake-if-idle` and #3164's automations can both land without touching a line of this; when they do, retirement is `rm -r apps/server/src/coil/loop apps/web/src/coil/Loop*` plus reverting three lines.

And it cannot run away. Two switches must be on, a hard 3-thread ceiling, 6 nudges per arm, 2 strikes on dead nudges, a 15/45-minute fuse, and a monotonic durable counter that only a human resets. The worst case is 18 wasted turns; the expected case is 2.

### Why it might lose

It is a timer, and a timer cannot distinguish "stopped" from "thinking hard about one thing". The whole design rests on the claim that `updatedAt` is a faithful liveness signal, and there is one place it demonstrably is not: a single long-running tool call emits `tool.started` and then nothing until `tool.completed`. `busyIdleMs = 45min` papers over that with a magic number rather than solving it, and when it is wrong the failure is _invisible_ — the nudge becomes a steer with no turn boundary (`ClaudeAdapter.ts:3729-3737`), so the user sees a derailed agent and no obvious cause. A design that maintained an open-tool/open-task set from `providerService.streamEvents` (`task.started`/`task.completed` pairing, `tool.started`/`tool.completed`) would be strictly more correct here; I traded that correctness for ~200 fewer lines, no TTL bookkeeping, and no dependency on trap #10's unpaired-`task.completed` hazard. That is a real trade, not a free one.

Second: the stop condition depends on the model doing what the prompt asks. `.t3x/loop-done` is only as good as the agent's willingness to write it, and prompt-dependent contracts rot silently across model versions. The budget catches it, but "stopped on budget" is a worse outcome than "stopped on done" every single time, and there is no telemetry in v1 that would tell the user which is happening without reading the timeline.

Third: it is per-thread and opt-in, which is honest but not what a user asked for at 2am. Someone who arms nothing gets nothing. A design that auto-armed any thread with an active turn would have saved the same night with zero clicks — I rejected it because auto-arming is exactly how a token-burn incident happens, but a reviewer could reasonably call the two-switch gate over-cautious for a beta the user explicitly requested.

Fourth: no cross-thread awareness and no backlog concept. This nudges a stalled thread; it does not pick the next task, does not read `GOALS.md`, does not write `iter-NNN.md`. If what the user actually wanted was their `autonomous-build-loop` skill running server-side, this is a much smaller thing wearing the same name.

### Guards

- `config.enabled` (env `T3X_LOOP_ENABLED`, default true) — the operator kill switch, checked once at layer construction; when false the fiber is never forked and a log line says so (mirrors `autoResume/Reactor.ts:261-264`).
- `store.global.enabled === true` — the user-facing beta toggle, read from the JSON store on every tick so flipping it off in Settings stops every armed thread within one poll without a restart.
- `record.armed === true` — per-thread, default **false**. Nothing is ever supervised implicitly. Two switches must both be on before a single token is spent.
- `getThreadShellById(threadId)` returns `Some` — `None` means deleted; disarm silently (no activity append, the thread is gone).
- `shell.archivedAt === null` — else disarm + `t3x.loop.stopped` (reason `archived`).
- `shell.settledOverride !== "settled"` — the user explicitly closed the thread. **Skip, do not consume budget, stay armed** (they may unsettle it). Never nudge a settled thread.
- `shell.settledOverride === "active"` (keep-active pin) — do NOT skip; this is the pin an overnight run legitimately has set. Nudge, then immediately dispatch `{type:"thread.unsettle", commandId, threadId, reason:"user"}` to re-assert the pin that `decider.ts:829` clears for any non-null `settledOverride`. The repair is issued **only** when the pre-dispatch shell showed `"active"`, so it can never create a pin the user did not ask for; and `decider.ts:509-534` always emits an event, so it cannot trip the engine's zero-event rejection.
- `shell.snoozedUntil === null || Date.parse(shell.snoozedUntil) <= now` — a live snooze means the user said "not now". Skip, do not consume budget, stay armed. This is the guard `autoResume` lacks (`guards.ts:99-103` checks only deletedAt/archivedAt/settled), and it exists because `decider.ts:845` clears snooze unconditionally on `thread.turn.start` with no opt-out.
- `isClaudeThreadShell(shell)` — `shell.session?.providerName?.toLowerCase() === "claudeAgent".toLowerCase()`, reusing the constant from `autoResume/guards.ts:92-96`. Non-Claude threads disarm: the whole stop contract is a Claude-CLI-shaped instruction.
- `!shell.hasPendingApprovals && !shell.hasPendingUserInput` — blocked on the human. Skip, do not consume budget, stay armed. Read off the SQL-backed shell (`orchestration.ts:434-435`), **not** via `hasOpenBlockingRequest`: the engine's in-memory read model boots from `getCommandReadModel()` with `activities: []` (`OrchestrationEngine.ts:301`, `ProjectionSnapshotQuery.ts:1536-1539`), so the decider-mirror path is blind to everything before the last restart.
- Synthetic turns: handled by never vetoing on `session.status`. A stuck synthetic turn (`ClaudeAdapter.ts:2469-2486`) only selects `busyIdleMs` instead of `idleMs`; it can never make the loop unfireable. This is the single most important guard decision in the design.
- Idle threshold met (see trigger rule), computed on a shell re-read immediately before the guard block and the dispatch — the same freshness discipline as `autoResume/Reactor.ts:179-183`, so state changed by an earlier dispatch in the same tick is always observed.
- `minNudgeSpacingMs`: `now - record.lastNudge.firedAtMs >= config.idleMs`. Redundant with the idle test (our own nudge bumps `updatedAt`), and kept precisely because it is redundant: if `updatedAt` ever fails to bump, this is the floor that makes a tight nudge loop structurally impossible.
- No pending auto-resume: `autoResumeStore.getThread(threadId).pending !== null` → skip, do not consume budget. Both reactors dispatch `thread.turn.start` and nothing upstream coordinates them; a rate-limited thread must not be nudged into the limit. `AutoResumeStore` is fork-owned and already module-scope memoised in `t3x/index.ts:35-42`, so providing it to the loop layer costs zero upstream surface.
- DONE sentinel absent or `mtime <= record.armedAtMs` (stop condition 1).
- `record.nudgeCount < config.maxNudges` (stop condition 2).
- `record.strikes < config.maxStrikes` (stop condition 3).
- Arm-time only, enforced in the HTTP route: fewer than `config.maxArmedThreads` (default 3, `T3X_LOOP_MAX_ARMED`) threads currently armed, else 409. A hard ceiling on total blast radius of 3 × 6 = 18 extra turns per arm cycle.

### UI surfaces

- **`ThreadCoilOverlay`** (`apps/web/src/coil/ThreadCoilOverlay.tsx`, new, fork-owned) — a per-thread aggregator that renders `<AutoResumeOverlay>`'s pill and `<LoopPill>` in one absolutely-positioned column. `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` line 18 and line 92 are **rewritten in place** (`AutoResumeOverlay` → `ThreadCoilOverlay`), not added to. Seam cost: **0 net** — the existing row's fork Δ (+10/-6, risk 80) is unchanged, and every future per-thread fork surface is now free. This is the same re-isolation RESEARCH.md recommends for `__root.tsx`, done here instead because this is where the feature actually lands.
- **`LoopPill`** (`apps/web/src/coil/LoopPill.tsx`, new, fork-owned) — collapsed: a dot + `Loop: off` / `Loop: watching · 15m` / `Loop: nudged 2/6` / `Loop: done` / `Loop: stalled`. Expanded: a `Switch` to arm/disarm, a `Textarea` for the per-thread nudge override (placeholder = the built-in text), and one line of status. Copies `AutoResumeOverlay.tsx` verbatim for the mechanics that matter — `ManagedRuntime.make(primaryEnvironmentHttpLayer)`, `resolvePrimaryEnvironmentHttpUrl`, hand-rolled `isJsonObject` parsers, 30 s poll + `window` focus listener, optimistic write with an in-flight counter gating the poll, 600 ms debounce with flush-on-thread-change, and **every failure collapsing to `null` so the pill disappears** rather than degrading chat. Seam cost: 0.
- **`LoopBetaSection`** (`apps/web/src/coil/LoopBetaSection.tsx`, new, fork-owned) — the global beta toggle. Mounted from `settings.beta.tsx`. Seam cost: 3 fork lines × churn 1 = **risk 3**, one new SEAMS.md row (row 35).
- **Timeline breadcrumbs** — `thread.activity.append` with fork-namespaced kinds, zero UI code: `t3x.loop.armed` (tone info), `t3x.loop.nudged` (info, `"Loop nudge 2 of 6 after 47 min of silence."`), `t3x.loop.stopped` (info for `done`/`disarmed`, **error** for `budget`/`stalled`, matching `autoResume`'s `capped` tone). `kind` is an open `TrimmedNonEmptyString` and `payload` is `Schema.Unknown` (`orchestration.ts:315-325`), so this is zero contract surface and renders in the existing timeline for free. Seam cost: 0.
- **No sidebar section.** `AppSidebarLayout.tsx:203` (churn 15, ~risk 30, would be a second new row) is explicitly declined: the per-thread pill answers 'is this thread being watched' at the only place you care, and the sidebar is precisely where upstream #3164's automations UI will land.

### New files

- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/config.ts — env-driven config (`T3X_LOOP_*`) with pure `resolveConfig(env)`, plus `resolveNudgePrompt({workspaceRoot, worktreePath, threadOverride})` resolving override → `<cwd>/.t3x/loop-prompt.md` → the built-in nudge text.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/state.ts — `LoopStore`: `t3x-loop.json` in `ServerConfig.stateDir`, `SynchronizedRef` + `writeFileStringAtomically`, global `{enabled}` plus per-thread `{armed, armedAtMs, nudgeCount, strikes, lastNudge, overridePrompt}`; every field `Schema.withDecodingDefaultKey` and `Object.hasOwn` record lookup, both copied from `autoResume/state.ts` for the reasons its comments give.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/guards.ts — pure predicates over `OrchestrationThreadShell`: `idleThresholdMsFor`, `idleMs`, `isClaudeThreadShell`, `threadIsGoneShell`, `blockedOnHuman`, `humanTookOver`, `strikeAfter`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/decide.ts — one pure function `decideLoopAction(input) => {kind: "skip" | "nudge" | "stop", reason, nextRecord}` containing every guard in order. No Effect, no IO — the entire policy is unit-testable from plain objects.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/sentinel.ts — `readDoneSentinel({worktreePath, workspaceRoot, armedAtMs})`: stats `.t3x/loop-done` in both roots, returns the newest mtime > armedAtMs or null; every error resolves to null. Read-only — never writes to the user's filesystem.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/Reactor.ts — `LoopReactorLive = Layer.effectDiscard(makeSupervisor)`; one scoped poll fiber; per armed thread `getThreadShellById` + `getProjectShellById` + sentinel stat + `decideLoopAction` + dispatch of `thread.turn.start` / conditional `thread.unsettle` / `thread.activity.append`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/http.ts — `LOOP_ROUTE_PATH = "/api/coil/loop"`; `GET ?threadId=` → `{globalEnabled, armedCount, thread:{armed, nudgeCount, maxNudges, strikes, lastNudgeAtMs, stoppedReason, overridePrompt, idleThresholdMs}}`; `POST` → `{globalEnabled?, threadId?, armed?, overridePrompt?}`. Same `Layer.unwrap` store-at-layer-construction trick and the same `authenticateWithOperateScope` mirror as `autoResume/http.ts:45-59,160-165`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/decide.test.ts — the policy matrix: every guard, every stop reason, the strike arithmetic, the human-takeover reset, the settled/snoozed/keep-active branches.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/guards.test.ts — threshold selection incl. the stuck-synthetic-turn case (status `running`, `updatedAt` 3h old → fires at busyIdleMs).
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/state.test.ts — decode defaults, corrupt-vs-unreadable file handling, prototype-key safety.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/sentinel.test.ts — mtime gating, worktree-vs-workspace precedence, missing-file and error paths.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/http.test.ts — auth/scope, 400s, `maxArmedThreads` 409, partial-field POST semantics.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/Reactor.test.ts — end-to-end against a stub engine + snapshot query: silence → nudge → sentinel → stop; budget exhaustion; two dead nudges → stalled; keep-active pin restored.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/loopClient.ts — fetch/parse/write helpers over `primaryEnvironmentHttpLayer`, every failure → null.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/LoopPill.tsx — the per-thread pill + expanded panel.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/ThreadCoilOverlay.tsx — per-thread fork-UI aggregator (AutoResumeOverlay + LoopPill), the single thing the thread route mounts.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/LoopBetaSection.tsx — the global beta toggle section for /settings/beta.

### Failure modes

- **Steering a legitimately-working turn.** A single tool call that runs >45 min with no intervening activity (a full `pnpm test` on this repo, a long EAS build) looks idle. The nudge is then silently absorbed as a steer into the live SDK loop (`ClaudeAdapter.ts:3729-3737`) — no new turn, so nothing in the UI shows a boundary — and the injected text can derail the agent mid-task. Mitigations: `busyIdleMs` 45 min; the built-in nudge text is written to be harmless as an interjection ("if you are still working, ignore this"); `T3X_LOOP_BUSY_IDLE_MS` is tunable per install. Not eliminated. This is the single realest downside of leaning entirely on `updatedAt`.
- **Token burn is bounded but not zero.** Worst case is `maxArmedThreads × maxNudges` = 3 × 6 = 18 extra user turns per arm cycle, each gated behind ≥15 min of silence, two switches, and a strike detector that kills a dead thread after 2 wasted nudges. A runaway is structurally impossible: the counter is monotonic, lives in the durable store, and only a human write to `/api/coil/loop` resets it. But 18 turns on a large context is real money if the user arms three threads and forgets.
- **The agent never writes the sentinel.** Then the loop stops on budget (6 nudges) rather than on DONE, and posts `t3x.loop.stopped (budget)` in the timeline. Degraded, not broken — and each of those 6 nudges is a nudge the user would otherwise have typed by hand. The mitigation is prompt quality, which is exactly the kind of thing that regresses silently across model versions.
- **A stale sentinel from a _concurrent_ process.** The mtime gate stops last night's file, but if some other tool in the same worktree writes `.t3x/loop-done` mid-run the loop stops early and quietly. Low likelihood, zero data loss, one toggle to re-arm.
- **Snooze/settled skips look like the feature is broken.** A user snoozes a thread and arms the loop; nothing ever fires and the pill just says `watching`. Correct behaviour (never clobber an explicit user intent) that reads as a bug. Partial mitigation: the pill surfaces `paused: snoozed` / `paused: settled` as its status line instead of a bare `watching`.
- **Keep-active pin repair is a two-dispatch race.** Between the `thread.turn.start` (which clears the pin at `decider.ts:829`) and the follow-up `thread.unsettle`, a client observing the shell sees `settledOverride: null` and may briefly re-bucket the thread in Sidebar v2. Sub-second, self-correcting, and strictly better than the alternative of either skipping pinned threads (breaks the main use case) or leaving the pin destroyed.
- **Two fork reactors, one thread.** The auto-resume guard (`pending !== null`) closes the window I can see, but there is no in-tree coordination primitive between fork reactors and no test that would catch a third one being added later. If someone adds a fourth `thread.turn.start` producer under `t3x/` without reading this, the guards do not compose.
- **No push to the UI.** Fork routes cannot subscribe (`EnvironmentSubscriptionRpcTag` is a closed union in `packages/client-runtime/src/rpc/client.ts:42-55`), so the pill polls at 30 s. A nudge that fires at T shows in the pill somewhere in T..T+30s. The timeline activity is immediate, so this is cosmetic.
- **Upstream #3164 lands automations and this becomes a parallel path.** SEAMS.md's documented hazard: a fork path that duplicates an upstream capability silently bypasses new upstream guards. The mitigation is that the whole feature is 7 fork-owned server files + 4 fork-owned web files + 3 lines of upstream edit — retirement is a delete, not an unwind — and the SEAMS.md 'Parallel paths' table must get a row for it at the next sync.
- **Silent no-op if the poll fiber dies.** `Effect.catchCause` inside `Effect.forever` handles per-tick failures, but a defect in the outer stream construction would leave the pill showing `watching` forever with nothing running. `autoResume` has the identical exposure; it is worth one boot log line and nothing more.

---

## BATON — the agent-authored loop contract

**Average score: 0/10**

> A fork-owned server reactor nudges a stalled thread with a structured re-prompt, and stops only when the agent itself writes `status: "done"` into a plain JSON contract file in the workspace — the same file the same agent would write under the bare Claude Code CLI.

### Core mechanism

**The contract.** Each armed thread owns one agent-authored file at `<workspaceRoot>/.t3x/loop/<threadId>.json`. Precedent for reading a workspace file already exists — auto-resume reads `<workspaceRoot>/.t3x/resume-prompt.md` (`apps/server/src/coil/autoResume/config.ts:82-113`). Shape: `{version:1, threadId, status:"working"|"blocked"|"done", iteration:int, updatedAt:iso, nextAction:string, remaining:string[], evidence:{commit,log}, doneReason:string|null, needsHuman:string|null}`. Per-thread (not one file per repo) because two T3 threads can share a workspace and must not fight over one status file. The supervisor only ever reads it; the agent only ever writes it. Nothing in the file is a T3 concept — a user running `claude` in a terminal with `ScheduleWakeup` writes the identical file, which is the whole CLI-compatibility argument.

**The reactor.** `apps/server/src/coil/loop/Reactor.ts` is `Layer.effectDiscard(makeSupervisor)`, copied verbatim in shape from `autoResume/Reactor.ts:295`, merged into `CoilLayerLive` in `apps/server/src/coil/index.ts` (churn 0). One scoped fiber, not two — the trigger is a timeout, not an event, so there is no detection stream. Every `pollMs` (30s) it walks the armed thread set from its own JSON store and, per thread, reads `snapshotQuery.getThreadShellById(threadId)` plus `getProjectShellById(shell.projectId)` for `workspaceRoot` — both single-row SQL, the pattern `webPush/Reactor.ts:80-87` already uses. `getSnapshot()` is never called; the SEAMS.md OOM hazard is not inherited.

**The nudge.** When the predicate fires, the reactor reads the contract, builds a re-prompt from `prompt.ts`, reserves the attempt in the store (`recordNudge` writes atomically **before** dispatch, auto-resume's anti-tight-loop lesson at `Reactor.ts:228`), then `engine.dispatch({type:"thread.turn.start", commandId: CommandId.make(\`t3x-loop:${uuid}\`), threadId, message:{messageId: MessageId.make(\`t3x-loop:${uuid}\`), role:"user", text, attachments:[]}, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, createdAt})`. That is byte-for-byte the keystroke path. No new command literal, no contracts edit, no `options.hooks`, no ClaudeAdapter edit. A breadcrumb goes to the timeline via `thread.activity.append`with kind`t3x.loop.nudged`—`kind`is an open`TrimmedNonEmptyString`and`payload`is`Schema.Unknown`, so this costs nothing (`packages/contracts/src/orchestration.ts:315-325`).

**The verdict pipeline.** All branching lives in a pure `decide.ts` — `decideNudge({shellFacts, contractRead, record, config, nowMs}) : {kind:"fire", tier, promptKind} | {kind:"skip", reason} | {kind:"park", reason, detail}` — with zero Effect, so every stop rule is a table-driven unit test. The Reactor is a thin I/O shell around it, the same split `autoResume/decide.ts` uses.

### Trigger rule

Fields read, all from one `OrchestrationThreadShell` (`packages/contracts/src/orchestration.ts:410-437`) plus the fork's own store record and the contract file. Fire iff **every** clause holds:

```
record.armed === true
&& record.parked === null
&& config.enabled && store.globalEnabled            // env kill switch AND beta toggle
&& shell exists (getThreadShellById returns Some — active rows only)
&& shell.archivedAt === null
&& shell.settledOverride !== "settled"
&& (shell.snoozedUntil == null || Date.parse(shell.snoozedUntil) <= nowMs)
&& shell.hasPendingApprovals === false
&& shell.hasPendingUserInput === false
&& isClaudeThread(shell)                             // reuse autoResume/guards.ts:92-96
&& nowMs - (record.lastDispatchAtMs ?? 0) >= config.minNudgeIntervalMs   // 8m floor
&& idleMs := nowMs - Date.parse(shell.updatedAt)
&& contract verdict is "continue" or "bootstrap"
&& all four budgets unspent
&& TIER passes:
     tier-1 (idleMs >= config.idleMs, default 8m) requires
        shell.latestTurn?.state !== "running"
        && shell.session?.status ∉ {"running","starting"}
     tier-2 (idleMs >= config.stuckMs, default 30m) requires nothing else.
```

`shell.updatedAt` is the load-bearing field and the reason this design needs no subagent bookkeeping at all: `thread.activity-appended` bumps `projection_threads.updated_at` in both the SQL pipeline (`ProjectionPipeline.ts:796-808`) and the in-memory projector (`projector.ts:747-750`), and background subagent `task.*` events **are** activity appends (`ProviderRuntimeIngestion.ts:489/542`). So while 1,358 subagent activities stream, `idleMs` stays near zero and the loop is silent; when the thread genuinely goes quiet, `idleMs` climbs. That is exactly issue #38's waveform, detected for free.

**Tier-2 is the deliberate answer to the synthetic-turn deadlock.** A background subagent's assistant message auto-opens a synthetic turn that pins `session.status = "running"` and `activeTurnId` forever (`ClaudeAdapter.ts:2469-2486`; the only closers are a later SDK `result` or the next `sendTurn`). Any "don't fire while progressing" guard — including auto-resume's `threadIsProgressing` — therefore never fires on precisely the threads this feature exists for. So after `stuckMs` of _zero_ activity we fire anyway, on the reasoning that 30 minutes of total silence on a nominally-running thread is empirically a stuck synthetic turn, and if we are wrong the message is absorbed as a harmless steer. The tier is recorded in the `t3x.loop.nudged` activity payload so a human can audit which branch fired.

**Confirmation is by `updatedAt`, never by turn id.** A nudge into a real running turn is silently absorbed as a steer with the same `turnId` and no `turn.started` (`ClaudeAdapter.ts:3729-3771`), so "watch for a new turn" is not available. Instead: if on a later tick `Date.parse(shell.updatedAt) < record.lastDispatchAtMs` and `nowMs - lastDispatchAtMs > 2 * config.idleMs`, the nudge was dead — increment `record.stalled`.

### Stop condition

Ten terminations, all of which write a timeline activity so the transcript itself records why the loop ended. Seven of them set a sticky `parked` record that only a human clears.

1. **DONE (declarative, the primary stop).** `contract.status === "done"` AND `contract.remaining.length === 0` AND `contract.doneReason` is a non-empty trimmed string AND the contract is **fresh**: `Date.parse(contract.updatedAt) >= record.lastDispatchAtMs`. Freshness is what defeats the two common lies — a leftover `done` from a previous run, and a `done` the agent wrote three hours before the current nudge and never revisited. The `remaining: []` clause defeats the third: declaring done while still listing open work. → `parked{reason:"done"}`, activity `t3x.loop.done` (info) carrying `doneReason` verbatim.
2. **BLOCKED (declarative).** `status === "blocked"` + non-empty `needsHuman` + fresh → `parked{reason:"blocked"}`, activity `t3x.loop.blocked` (error) with the text. Amber pill.
3. **NO PROGRESS.** `contract.iteration` must strictly increase across consecutive fires. If `contract.iteration <= record.lastSeenIteration`, or the nudge was dead per the confirmation rule above, `record.stalled += 1`. At `stalled === 2` the next nudge switches to the **unstick** prompt variant. At `stalled >= 3` → `parked{reason:"no-progress"}`. This is the hard guard against burning a night's tokens on a model that says "working" forever.
4. **NO CONTRACT.** Missing file, unparseable JSON, schema failure, or `contract.threadId !== threadId` increments `record.contractFaults`; a good read resets it to 0. At `contractFaults >= 3` → `parked{reason:"no-contract"}`. Two-strikes-then-park is the answer to "the agent forgot to write the file": the nudge text restates the full schema every single time, so a genuine forget self-heals in one round trip, and a model that structurally cannot comply costs at most 3 turns.
5. **RUN BUDGET.** `record.nudgesThisRun >= config.maxNudgesPerRun` (40) → `parked{reason:"budget"}`.
6. **24h CAP.** `countNudgesSince(threadId, nowMs - 24h) >= config.maxNudgesPer24h` (60) → `parked{reason:"capped"}`. Mirrors auto-resume's dual-check cap (checked at plan time _and_ fire time) with a 25h history prune.
7. **DEADLINE.** `nowMs - record.armedAtMs > config.runMaxMs` (12h) → `parked{reason:"deadline"}`. Survives a server restart because `armedAtMs` is durable.
8. **HUMAN DISARM.** `record.armed` is re-read at fire time, not trusted from the planning pass (auto-resume Guard 5, `Reactor.ts:192-202`). Toggling the thread switch off is the immediate human stop.
9. **THREAD GONE.** Shell missing / archived / `settledOverride === "settled"` / not a Claude thread → disarm silently, no activity (a deleted thread's timeline is not worth writing to).
10. **HUMAN TAKEOVER (a reset, not a stop).** If `shell.latestUserMessageAt` advances from a message the loop did not send, the run's counters (`nudgesThisRun`, `stalled`, `contractFaults`) reset and `armedAtMs` re-bases. A human who steps in earns the loop a fresh budget rather than inheriting an exhausted one.

**Un-parking is human-only.** The overlay shows the park reason and a single "Resume loop" button that clears `parked`, zeroes the counters and re-bases `armedAtMs`. There is no automatic un-park, because every park reason is either success or a condition that will recur immediately.

### Settings surface

**Global, at `/settings/beta`.** A fork-owned `<LoopBetaSection />` renders as a sibling of `<BetaSettingsPanel />` inside `apps/web/src/routes/settings.beta.tsx` — an 11-line file at churn 1, the cheapest settings mount in the tree (`SettingsPanels.tsx` is churn 18 / risk 1044; this is risk 2). It imports `SettingsPageContainer` / `SettingsSection` / `SettingsRow` from `~/components/settings/settingsLayout` (churn 6, not a seam — free to import) and `Switch` / `Input` from `~/components/ui/*`, and copies `BetaSettingsPanel.tsx`'s conditional-children shape (lines 86-116) verbatim.

Rows:

1. **"Loop supervisor (beta)"** — `Switch`, default **off**. The master gate. When off the reactor evaluates nothing and `<LoopOverlay>` returns `null` on every thread.
2. **"Nudge after"** — minutes, default 8, range 2–120 → `idleMs`.
3. **"Give up after"** — nudges, default 40, range 1–200 → `maxNudgesPerRun`.
4. **"Stop the run after"** — hours, default 12, range 1–48 → `runMaxMs`.

Rows 2-4 render only when row 1 is on. The numeric inputs reuse `BetaSettingsPanel`'s `AutoSettleDaysInput` draft-state pattern (local draft, commit only on a valid integer, snap back on blur) rather than importing it, since it is module-private there.

**Backed by the fork's JSON store, not `packages/contracts/src/settings.ts`.** That file is churn 18, is a _persisted_ schema where one bad value discards the entire blob, and is the exact anchor that produced issue #29. It also physically cannot work here: `ServerSettings` decoding drops unknown keys and `writeSettingsAtomically` re-encodes from the decoded value, so a smuggled `t3x` key is erased on the next settings write. Instead the four globals live at the top level of `<stateDir>/t3x-loop.json` and are read/written through `POST /api/coil/loop` with no `threadId`. Every field uses `Schema.withDecodingDefaultKey` so an older state file still decodes (`autoResume/state.ts:44-54`).

**Per-thread arming is NOT in settings — it lives in the thread overlay.** Global = "this feature exists"; per-thread = "loop _this_ thread", with a goal textbox. A global setting that started nudging every thread you own would be a footgun, and the split also means the beta toggle is a true kill switch with one place to look.

**Env stays the ops override.** `T3X_LOOP_ENABLED=false` hard-disables regardless of the UI toggle (the auto-resume kill-switch precedent), and every numeric has a `T3X_LOOP_*` default that the UI value overrides when non-null. Settings-search registration is deliberately skipped (`searchableSetting` is type-constrained to upstream's catalog; registering means editing `settingsSearch.ts` and adding a ledger row for a cosmetic win).

### Seam cost

Measured against merge-base `64bf01619` with the SEAMS.md recipe, re-run this session (self-check passed: `ChatView.tsx` = 63).

| upstream file                                            | fork lines added                                | churn (60d) | risk  |
| -------------------------------------------------------- | ----------------------------------------------- | ----------- | ----- |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` | +1 (`<LoopOverlay threadRef={threadRef} />`)    | 5           | **5** |
| `apps/web/src/routes/settings.beta.tsx`                  | +2 (import + `<LoopBetaSection />`)             | 1           | **2** |
| `apps/server/src/server.ts`                              | 0 — the 3-line seam (59/224/422) already exists | 29          | **0** |
| `apps/server/src/coil/index.ts`                           | +4, fork-owned aggregator                       | 0           | **0** |
| `packages/contracts/**`                                  | 0                                               | —           | **0** |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`       | 0                                               | 12          | **0** |
| `apps/server/src/persistence/Migrations.ts`              | 0                                               | 6           | **0** |

**Total added risk: 7. New ledger rows: 1** (`settings.beta.tsx`; the thread-route row already exists at risk 80 and grows to 85).

SEAMS.md's tripwire says "before adding row 35, re-isolate something instead", so this ships as **two PRs**, and PR 1 is a hard prerequisite, not a nicety: collapse the three fork mounts in `apps/web/src/routes/__root.tsx` (`NotificationCoordinator`, `ThreadOutboxDrain`, `PushSubscriptionManager`) into one fork-owned `<CoilRoot />` in `apps/web/src/coil/index.tsx`. That takes 6 fork lines to 2 in a churn-9 file: **risk 54 → 18, a net −36**, and makes every future web feature seam-free. Ledger delta for the whole series: **−36 + 2 + 5 = −29.** The fork's seam surface shrinks while the feature lands, which is what the tripwire asks for.

Deliberately not paid: no WS-RPC (would cost `contracts/rpc.ts` churn 15 + `ws.ts` churn 41), no orchestration command literal (`contracts/orchestration.ts` churn 12 — and the exact anchor upstream #5123's `thread.wake-if-idle` and #3164's snooze `condition` field will land on), no migration (`036_*` collides by number with upstream's next), no `settings.ts` field (churn 18, persisted schema), no `SettingsPanels.tsx` row (risk 1044), no sidebar edit (churn 32/33), no new route file (regenerates the tracked `routeTree.gen.ts`).

### Claude Code CLI compatibility

Maximal, and by construction rather than by accident.

**The nudge is an ordinary user turn.** `thread.turn.start` → the decider → `ProviderCommandReactor` → `ClaudeAdapter.sendTurn` → `Queue.offer` onto the streaming prompt queue the live SDK loop is already consuming. It is indistinguishable from a keystroke in the composer. No `options.hooks`, no `extraArgs`, no adapter edit, no SDK feature that the terminal CLI lacks.

**The stop condition is a file the agent writes with `Write`.** Nothing bespoke. Run `claude` in a terminal on the same repo, have it write `.t3x/loop/<id>.json`, and the protocol is identical — the only difference is who schedules the next turn (`ScheduleWakeup`/`/loop`/`CronCreate` in the CLI; this reactor in T3). The scheduler is exactly the one capability the Agent SDK does not expose to a server-side driver, and it is the only thing this design supplies.

**It composes with the user's existing `autonomous-build-loop` skill instead of competing with it.** The bootstrap prompt contains one explicit line: _"If this repo has a CLAUDE.md autonomous-build-loop protocol section, follow it for the work — read `.loop/state.json`, `logs/latest.md`, and the backlog exactly as it says. Use the contract file purely as your status report to me, and do NOT call ScheduleWakeup: I am the scheduler for this thread."_ That resolves the one genuine conflict (two schedulers) in a sentence, keeps `iter-NNN.md` / `GOALS.md` / `logs/blocks.md` as the substrate, and maps the skill's `iter` counter onto the contract's `iteration` field.

**The `.t3x/loop-prompt.md` override** lets a user replace the instruction half of the nudge wholesale, mirroring the established `.t3x/resume-prompt.md` precedent. The machine-readable contract block is always appended, because the stop condition depends on it — an override can change _what work to do_, never _how to report done_.

**Deliberately unused CLI/SDK surfaces**, all deferred: `Stop`/`SubagentStop` hooks and their `background_tasks` roster (would require `options.hooks` in `ClaudeAdapter.ts`, churn 12); `task_updated` / `is_backgrounded`; `background_tasks_changed`; `query.backgroundTasks()` (it backgrounds tasks rather than listing them). None are needed because `shell.updatedAt` already encodes subagent liveness.

### Why it wins

**The stop condition is the hard part, and this is the only framing where it is declarative rather than inferred.** Every alternative has to guess "is it done?" from projections — and projections cannot distinguish a finished agent from a wedged one, which is exactly why issue #38 happened. Here the agent states it, in writing, with a justification, and the supervisor's job collapses to validating a claim instead of divining one.

**The trigger is free and already correct.** `now - shell.updatedAt` is subagent-aware without a single line of task bookkeeping, because `thread.activity-appended` bumps `updated_at` in both projectors and subagent `task.*` events are activity appends. It stays silent through all 1,358 of issue #38's background activities and fires at exactly the moment the thread went dark. No open-task map, no TTL, no pairing assumptions about `task.started`/`task.completed`, no `raw.payload` archaeology.

**It refuses the deadlock every obvious design walks into.** Reusing `threadIsProgressing` would make the loop permanently silent on precisely the threads it exists for, because a stuck synthetic turn pins `session.status` to `running` forever. The two-tier rule names that trap and prices it: fire cleanly at 8 minutes when the turn is closed, fire anyway at 30 minutes of total silence, and accept a harmless steer as the cost of never deadlocking.

**Seam cost is 7 and the ledger goes down.** One new row on the cheapest file in the tree, one line added to a row that already exists, a mandatory prerequisite that removes 36 risk, zero contracts edits, zero migrations, zero adapter edits. It cannot collide with upstream #3164 or #5123 because it adds no command literal, no automation registry, and nothing named "automation" — and when `thread.wake-if-idle` lands, this becomes a caller of it with no migration.

**Every termination is auditable in the transcript.** A human scrolling the thread at 8am sees `t3x.loop.nudged` × 12, then `t3x.loop.done` with the agent's own reason — or `t3x.loop.parked: no progress after 3 nudges`. Debugging a bad night takes one scroll, not a log dive.

### Why it might lose

**It outsources the hardest judgement to the thing that just failed.** The stop condition is only as honest as the agent writing it, and the agent in issue #38 was already mis-reporting completion — it marked a turn `completed` while 33 minutes of work remained. A model that will lie about being done will lie in JSON just as readily. The freshness check, the `remaining: []` clause and the strict-iteration rule raise the cost of lying but do not make it impossible, and a confabulated `done` ends the run early and silently. A design that inferred completion from the diff or the test suite would be harder to fool.

**It is a protocol, and protocols degrade.** If the agent does not honor the contract the feature does not fail loudly — it parks after three turns and goes quiet, which from the user's chair looks exactly like the bug it was built to fix. There is no fallback mode that keeps nudging with a weaker stop rule, because that fallback is precisely how you burn a night's tokens.

**Tier-2 is a knowingly wrong guess some of the time.** Firing into a possibly-live turn after 30 silent minutes will occasionally derail a long legitimate operation by injecting a steer, and the user will experience that as the supervisor breaking their build. The honest defence is that it is bounded and configurable, not that it is correct.

**The prerequisite PR is unrelated work.** `<CoilRoot />` exists only to pay the tripwire; it touches three shipped features' mount points and needs its own review, so the series is two PRs where a competing design that adds no new ledger row would be one.

**A polling reactor is coarse.** 30-second ticks plus 30-second web polling means the UI can lag the truth by a minute, and the beta toggle can leak one stale nudge after being switched off. An event-driven design off `streamDomainEvents` would be tighter — but it cannot detect _absence_ of events, which is the whole signal here.

### Guards

- Re-read `record.armed` from the store at fire time — the user can toggle a thread off after it was scheduled (auto-resume Guard 5, `autoResume/Reactor.ts:192-202`).
- `record.parked === null` — a parked loop is sticky and only a human 'Resume loop' click clears it.
- `config.enabled` (env `T3X_LOOP_ENABLED`, read once at layer construction) AND `store.globalEnabled` (the beta toggle). Env false hard-disables the reactor before any fiber forks, matching `autoResume/Reactor.ts:261-264`.
- `getThreadShellById(threadId)` returns `Some` — the query serves active rows only, so deleted threads fall out here.
- `shell.archivedAt === null` and `shell.settledOverride !== "settled"` — the shell-level equivalent of `guards.ts:99-103` `threadIsGone`.
- SNOOZE (auto-resume has no such guard; the loop does): skip entirely if `shell.snoozedUntil` is in the future. `thread.turn.start` unconditionally emits `thread.unsnoozed(reason:"activity")` (`decider.ts:845-857`) with no opt-out, so the only way not to clobber a human's snooze is to not dispatch. A snoozed thread is a human saying 'not now'; the loop waits it out rather than overriding it.
- KEEP-ACTIVE PIN (trap #9): the decider unsettles for `settledOverride !== null` (`decider.ts:829`), which destroys a `"active"` keep-active pin too. Handled by re-assertion, not avoidance: if `shell.settledOverride === "active"` at fire time, record it, dispatch the turn, then dispatch `{type:"thread.unsettle", commandId: CommandId.make(`t3x-loop-pin:${uuid}`), threadId, reason:"user"}` — the existing command that sets the pin back to `"active"` (`packages/contracts/src/orchestration.ts:594-601`). Best-effort, wrapped in `Effect.catchCause` → logWarning; a failed re-assert leaves the pin cleared and is logged, never fatal.
- BLOCKING REQUESTS: skip when `shell.hasPendingApprovals || shell.hasPendingUserInput`. These SQL-backed shell booleans are used deliberately instead of the fork's `hasOpenBlockingRequest(thread.activities)` mirror, because the engine's in-memory read model boots from `getCommandReadModel()` with activities empty (`OrchestrationEngine.ts:301`), so the mirror is blind to anything before process start. After `config.blockedNoticeMs` (15m) of continuous blocking, post a one-shot `t3x.loop.waiting` activity so the human can see why the loop went quiet, then stay silent.
- SYNTHETIC TURNS: never gated on `session.status`/`latestTurn.state` alone, because a stuck synthetic turn pins both to `running` forever (`ClaudeAdapter.ts:2469-2486`). Tier-1 requires them non-running; tier-2 (30m of zero `updatedAt` movement) overrides them explicitly. Documented as a deliberate steer-risk trade in the module header.
- STEER ABSORPTION: never confirm a dispatch by watching for a new `turnId` (`ClaudeAdapter.ts:3729-3771` — a mid-turn `sendTurn` reuses the same turn and emits no `turn.started`). Confirmation is `shell.updatedAt` moving past `record.lastDispatchAtMs`.
- RATE FLOOR: `nowMs - record.lastDispatchAtMs >= config.minNudgeIntervalMs` (8m), independent of the idle test. This is also the interlock with the auto-resume reactor: an auto-resume dispatch bumps `updatedAt`, suppressing a loop nudge for a full `idleMs`; and because a loop nudge is a real user message, it trips auto-resume's `user-took-over` cancel (`guards.ts:124-146`). Both directions are safe with no new coordination code.
- `isClaudeThread(shell)` — imported from `autoResume/guards.ts:92-96`, not re-mirrored (SEAMS.md forbids two independent mirrors of the same helper).
- BUDGETS, all four checked immediately before dispatch: `nudgesThisRun < maxNudgesPerRun`, `countNudgesSince(now-24h) < maxNudgesPer24h`, `now - armedAtMs < runMaxMs`, `stalled < maxStalled`.
- RESERVE-BEFORE-DISPATCH: `store.recordNudge(threadId, nowMs, contract.iteration)` persists atomically _before_ `engine.dispatch`, so a dispatch failure can never tight-loop retry (`autoResume/Reactor.ts:228`).
- CONTRACT IDENTITY: `contract.threadId` must equal the thread being nudged, and `contract.version` must be `1`. A mismatch counts as a contract fault, so a copy-pasted contract from another thread cannot silently drive the wrong loop.

### UI surfaces

- **`<LoopOverlay threadRef={threadRef} />`** — mounted in `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` as a second sibling next to the existing `<AutoResumeOverlay>` (line 92). Seam cost: **+1 line on an existing ledger row**, churn 5 → risk 5. Positioned at `top-[calc(var(--workspace-topbar-height)+2.75rem)] right-3 z-30` so it stacks under the auto-resume pill instead of colliding with it (that overlay owns `+0.5rem`). Renders `null` when the global beta toggle is off or the route 404s.
- **Pill states** (colors taken from `Sidebar.logic.ts:574-639` so it reads native): off → muted dot, "Loop: off"; armed and quiet → "Loop: on · iter 6 · next ~4m"; nudging → sky pulse dot, "Loop: nudged 3 of 40"; parked done → emerald, "Loop: finished"; parked blocked → amber, "Loop: needs you"; parked other → destructive, "Loop: stopped — no progress". Seam cost: 0.
- **Expanded panel** — `Switch` to arm, a debounced `Textarea` for the run goal (the exact 600ms debounce + flush-on-thread-change machinery `AutoResumeOverlay.tsx:268-321` already solves), the last-read contract summary (status / iteration / nextAction / `remaining.length`), the park reason and `doneReason`/`needsHuman` text, and a `Button` labelled "Resume loop" when parked. Seam cost: 0 (all `~/components/ui/*` imports).
- **`<LoopBetaSection />`** in `apps/web/src/routes/settings.beta.tsx`. Seam cost: **+2 lines, NEW ledger row 35**, churn 1 → risk 2.
- **Timeline activities** — `t3x.loop.armed`, `t3x.loop.nudged` (payload `{tier, index, iteration}`), `t3x.loop.waiting`, `t3x.loop.done`, `t3x.loop.blocked`, `t3x.loop.parked`. These render in the existing thread timeline with zero code because `kind` is an open string and `payload` is `Schema.Unknown`. Seam cost: 0. This is the primary audit surface — the transcript records every nudge and the exact reason the loop stopped.
- **No sidebar surface at all.** Deliberate omission: `SidebarV2.tsx` is churn 33 and `Sidebar.tsx` churn 32, making a pinned-loop-threads section the single most expensive edit available (~1300 risk), and issue #38's pain was 'nobody nudged the thread', not 'I could not find the thread'. If a shelf is ever wanted, the one-line mount at `AppSidebarLayout.tsx:203` (churn 15) is the entry point — but not in v1.

### New files

- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/contract.ts — the loop-contract Schema, `LOOP_CONTRACT_DIR = ".t3x/loop"`, and `readContract(workspaceRoot, threadId)` returning a `{ok|missing|invalid|mismatched}` union; never fails.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/decide.ts — the entire pure verdict function `decideNudge(...) : Fire | Skip | Park`; every trigger clause, every stop rule, zero Effect, table-testable.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/prompt.ts — `buildNudgePrompt({kind:"bootstrap"|"standard"|"unstick", ...})` plus `LOOP_PROMPT_RELATIVE_PATH = ".t3x/loop-prompt.md"` override resolution mirroring `resolveResumePrompt`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/state.ts — durable `t3x-loop.json` store (`SynchronizedRef` + `writeFileStringAtomically`, `Object.hasOwn` lookup, every field `withDecodingDefaultKey`, 25h nudge-history prune).
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/config.ts — env-only `T3X_LOOP_*` defaults and parsers, copied from `autoResume/config.ts`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/guards.ts — shell-level predicates (`shellIsGone`, `shellIsBlocked`, `shellIsSnoozed`, `shellIdleMs`, `resolveTier`); imports `isClaudeThread` from `../autoResume/guards.ts` rather than re-mirroring it.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/Reactor.ts — one self-starting scoped poll fiber; `LoopReactorLive = Layer.effectDiscard(makeSupervisor)`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/http.ts — `LOOP_ROUTE_PATH = "/api/coil/loop"`, GET/POST, mirrored `authenticateWithOperateScope`, `Layer.unwrap` so the store requirement never reaches upstream's `makeRoutesLayer`.
- /Users/rajdholakia/Developer/t3code-loop/apps/server/src/coil/loop/{decide,contract,prompt,state,guards,http,Reactor}.test.ts — seven fork-owned specs; none appended to an upstream file (the issue-#29 rule).
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/loopClient.ts — `readLoopState` / `writeLoopState` over `ManagedRuntime.make(primaryEnvironmentHttpLayer)` + `resolvePrimaryEnvironmentHttpUrl`, hand-rolled narrowing parsers, every failure collapsing to `null`.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/LoopOverlay.tsx — the per-thread pill + expanded panel.
- /Users/rajdholakia/Developer/t3code-loop/apps/web/src/coil/LoopBetaSection.tsx — the four beta settings rows.
- /Users/rajdholakia/Developer/t3code-loop/docs/coil/loop/DESIGN.md — the contract spec, the tier-2 rationale, and the CLI-parity note, so a future sync can re-derive why tier-2 exists.

### Failure modes

- **Token burn.** Bounded by four independent caps, but the worst case is real: 60 nudges per thread per 24h, each potentially a fat multi-subagent iteration. Defaults are chosen conservatively (`maxNudgesPerRun` 40, `runMaxMs` 12h) and the no-progress park at 3 kills the pathological case fast, but a _productive_ loop legitimately spending 40 fat iterations overnight is expensive by design. The beta toggle and the per-thread arming exist precisely so this is never accidental.
- **Ping-pong with a model that ignores the protocol.** If the agent never writes the contract, the loop costs exactly 3 wasted turns then parks with `no-contract` and stops. Safe, but the feature silently does nothing for that user — the overlay's park reason is the only signal, so a user who never opens the panel sees a feature that 'did not work'.
- **Hallucinated done.** Freshness + `remaining: []` + a non-empty `doneReason` raise the bar but cannot eliminate it. A determined confabulation ends the run early and the human finds out at the next check-in. The `t3x.loop.done` activity carries `doneReason` verbatim so the lie is at least on the record. Verifying `evidence.commit` against git would need the reactor to shell out — deliberately not built in v1.
- **Hallucinated working.** The mirror failure: the agent keeps returning `status:"working"` with a bumped `iteration` while doing nothing real. Strict iteration monotonicity does not catch a liar who increments the counter. Nothing in v1 catches this; the 24h cap and the run deadline are the backstop. Documented as the single largest residual hole.
- **Tier-2 fires into a genuinely live turn.** A 30-minute silent tool call (a huge build, a long test suite) looks identical to a stuck synthetic turn in the projections. The nudge is absorbed as a steer (`ClaudeAdapter.ts:3729`), injecting an unrelated instruction mid-flight, which can derail a long operation. Mitigated only by the 30-minute default; users with long silent operations should raise `T3X_LOOP_STUCK_MS`.
- **Keep-active pin lost.** `thread.turn.start` clears `settledOverride` for any non-null value (`decider.ts:829`). Re-assertion via `thread.unsettle{reason:"user"}` is best-effort; if that second dispatch fails the pin is gone and only a log line records it. There is a millisecond window where the thread has no pin.
- **Two loops in one workspace.** Per-thread contract paths stop them overwriting each other's status, but two armed threads in the same repo will happily edit the same files. Not solved. The arming UI is explicit and per-thread, which is the entire mitigation.
- **Torn contract read.** The agent writes the file non-atomically; the reactor could read mid-write. Reads happen only after `idleMs` of quiet so the window is small, and a torn read costs one contract fault out of three. A corrupt file that never gets rewritten parks the loop in 3 ticks rather than looping forever.
- **Lost nudge on crash.** A turn dispatched immediately before a process death is settled to `interrupted` by `CrashRecoveryReconciler`; the next tick sees an idle non-running thread and nudges again. Correct, at the cost of one duplicate nudge. `armedAtMs` and the nudge history survive in the JSON store, so the deadline and cap are not reset by a restart.
- **Store decode failure wipes all loop state.** `autoResume/state.ts`'s boot path collapses an unparseable file to `EMPTY_STATE`, silently disarming every thread. Inherited verbatim (including the 'unreadable → run in-memory, do not overwrite' branch). Mitigated by `withDecodingDefaultKey` on every field so field additions never trigger it.
- **Beta toggle drift.** The global toggle lives in the fork JSON store and is read by the reactor at tick time, but the web reads it on a 30s poll with no push channel. A user flipping it off sees the overlay disappear immediately (optimistic write) while the reactor picks it up on its next 30s tick — up to one stale nudge can slip through.

---

## RUNWAY — turn-boundary continuation with a budget ledger

**Average score: 0/10**

> Every non-synthetic turn that completes on an armed thread arms a continuation; a durable per-run budget ledger (iterations / deadline / USD / context-fraction) decides whether to spend the next iteration, and an idle sweep is only the net for when the turn-completed edge is unreliable.

### Core mechanism

Two scoped fibers in one fork-owned reactor at `apps/server/src/coil/loop/Reactor.ts`, self-starting via `Layer.effectDiscard` exactly like `AutoResumeReactorLive` (autoResume/Reactor.ts:295), merged into `CoilLayerLive` (t3x/index.ts:71). Fiber A is the LEDGER TAP: `Stream.runForEach(providerService.streamEvents, ...)` maintaining an in-memory `Map<ThreadId, RuntimeLedger>`. It never dispatches. It reacts to five event types. `turn.started` — if `event.raw?.method === "claude/synthetic-turn-start"` the turnId goes into a bounded synthetic-turn set; the real path emits `turn.started` with NO `raw` field at all (ClaudeAdapter.ts:3793-3800 sets `providerRefs: {}` and no `raw`, vs :2500-2508 which sets `raw.method = "claude/synthetic-turn-start"`). That difference is on the wire today and is the zero-seam answer to fact #7. `turn.completed` — if the turnId is synthetic it is ignored entirely (no cost charged, no continuation armed); otherwise the ledger charges `payload.totalCostUsd` (ClaudeAdapter.ts:2050-2053 populates it from `SDKResultSuccess.total_cost_usd`) and arms `armedAtMs = now`. `thread.token-usage.updated` — records `usage.usedTokens` / `usage.maxTokens` / `usage.totalProcessedTokens`. `task.started` / `task.completed` — an open-task set keyed by `payload.taskId` with a 15-minute TTL per entry, because `task.completed` is emitted only from `task_notification` and may never arrive (fact #10). `account.rate-limits.updated` with a rejected verdict — sets a deference flag so RUNWAY yields to the auto-resume reactor.

Fiber B is the TICK, every `pollMs` (default 15s), and it is the only place that dispatches. For each thread with `run.state === "running"` in the durable store it reads one row via `snapshotQuery.getThreadShellById(threadId)` (the webPush pattern, never `getSnapshot()`), then calls a pure `decideContinuation()` in `decide.ts` that returns `Dispatch | Skip(reason) | Halt(reason)`. Dispatch is `engine.dispatch({type:"thread.turn.start", commandId: CommandId.make(\`t3x-loop:${uuid}\`), threadId, message:{messageId: MessageId.make(\`t3x-loop:${uuid}\`), role:"user", text, attachments:[]}, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, createdAt})`— byte-for-byte the auto-resume path (autoResume/Reactor.ts:109-122). The iteration is committed to the durable store BEFORE dispatch (the`recordFired`-before-dispatch discipline at autoResume/Reactor.ts:231) so a dispatch failure cannot tight-loop.

The QUIET WINDOW is what makes the turn edge usable given issue #38. A continuation armed at `armedAtMs` becomes eligible at `quietUntilMs = armedAtMs + settleMs` (default 45s), but while the open-task set is non-empty or any ledger event has arrived more recently, `quietUntilMs` is pushed to `lastLedgerEventAtMs + settleMs`, hard-capped at `armedAtMs + maxDrainMs` (default 10 min). On thread 3a85bdd3 — turn `completed` at 00:19:19Z with 1,358 activities still arriving for 33 minutes — RUNWAY re-arms continuously through the drain and fires at the 10-minute cap, or 45s after the true last activity, instead of 3h31m later.

The IDLE NET is the second eligibility path, not the primary one: `now - Date.parse(shell.updatedAt) >= idleGraceMs` (default 12 min) with no armed continuation. It exists for three cases the turn edge cannot cover — a server restart that lost the hot stream (both `providerService.streamEvents` and `engine.streamDomainEvents` are hot-only, no replay), a `turn.completed` that never fires because the session wedged, and a run armed while a turn was already mid-flight. Because `thread.activity-appended` bumps `projection_threads.updated_at` in both the SQL pipeline (ProjectionPipeline.ts:796-808) and the projector (projector.ts:747-750), and background subagent task activities ARE activity appends, this test is subagent-aware for free.

TOKEN ACCOUNTING deviates from the obvious reading of `context-window.updated`. Those activities are the right signal for the wrong metric: `usedTokens` is context OCCUPANCY, it drops after a compaction, so it is monotonically wrong as a spend meter. The ledger therefore reads `usedTokens/maxTokens` purely as a STOP signal (`contextFraction >= maxContextFraction`, default 0.85 — past that the next iteration is mostly re-compaction, which is where unattended loops burn money for nothing), and measures spend from `turn.completed.totalCostUsd` (real dollars) plus `ThreadTokenUsageSnapshot.totalProcessedTokens` (monotonic). It reads them off the runtime stream rather than the activity table, because the projection drops `usedTokens <= 0` rows (ProviderRuntimeIngestion.ts:594-598) and `ActivityPayloadProjection.ts:211-220` keeps only the last resolvable context-window activity per turn.

### Trigger rule

DISPATCH iff the run is `running` AND every guard passes AND `decideBudget()` returns `continue` AND at least one eligibility path is open:

PRIMARY (turn edge): `ledger.armedAtMs !== null && nowMs >= ledger.quietUntilMs`, where arming happens only on a `turn.completed` runtime event whose `event.turnId` is NOT in `ledger.syntheticTurnIds`, and `quietUntilMs = min(armedAtMs + maxDrainMs, max(armedAtMs, lastLedgerEventAtMs) + settleMs)` with `lastLedgerEventAtMs` advanced by any `task.*`, `tool.*`, `thread.token-usage.updated` or assistant item event on that thread.

SAFETY NET (idle): `nowMs - Date.parse(shell.updatedAt) >= idleGraceMs` (default 720_000).

BACKOFF FLOOR applies to both: `nowMs - run.lastDispatchAtMs >= gapLadderMs[min(run.consecutiveNoProgress, 3)]` with ladder `[90_000, 180_000, 480_000, 1_200_000]`, clamped to the last rung exactly like `backoffDelayMs` (autoResume/config.ts:76-80).

Exact fields read, all from `OrchestrationThreadShell` (contracts/orchestration.ts:410-437) plus the fork's own store: `shell.updatedAt`, `shell.session?.status`, `shell.session?.providerName`, `shell.latestTurn?.state`, `shell.latestUserMessageAt`, `shell.hasPendingApprovals`, `shell.hasPendingUserInput`, `shell.snoozedUntil`, `shell.settledOverride`, `shell.archivedAt`, `shell.deletedAt` (via `threadIsGone`), `shell.runtimeMode`, `shell.interactionMode`, `shell.projectId`. From the ledger: `armedAtMs`, `quietUntilMs`, `syntheticTurnIds`, `openTaskIds`, `costUsdSinceRunStart`, `lastContextFraction`, `rateLimitRejected`. From the store: `run.state`, `run.startedAtMs`, `run.budget.*`, `run.spent.*`, `run.lastDispatchAtMs`, `run.lastDispatchedMessageId`, `run.consecutiveNoProgress`, `run.blockedSinceMs`, `run.lastHaltFileMtimeMs`.

NOTE `shell.session.status` is read but NEVER used as a "don't fire while running" gate — see guards.

### Stop condition

Six halt reasons in `decide.ts`, evaluated in this fixed order so a human always beats a budget and a budget always beats "keep going". Halting is terminal and idempotent: `run.state = "halted"`, one `t3x.loop.halted` activity, one Web Push, and the run is retained 7 days for the UI.

1. `user-took-over` — `Date.parse(shell.latestUserMessageAt) > run.lastDispatchAtMs + 2000`. Our own dispatches also move that field, hence the 2s epsilon anchored to our own dispatch timestamp rather than a message-id read (shell has no message id; this keeps the check to one SQL row). A human typing is an unconditional halt — the entire point of #38 is that the human should not have to be the loop.

2. `blocked` — `shell.hasPendingApprovals || shell.hasPendingUserInput`. This is a PAUSE, not a halt: no dispatch, run stays `running`, one edge-detected `t3x.loop.waiting` activity. If the block outlives `blockedTimeoutMs` (default 30 min) it escalates to a real halt `blocked-timeout` with an error-tone activity and a push — an unattended run parked on an approval at 02:00 is exactly as dead as a stalled one.

3. `agent-signalled` — THE CLI-COMPATIBLE STOP, two channels, either sufficient. (a) FILE: `<workspaceRoot>/.t3x/loop-stop` exists with `mtime >= run.startedAtMs`; its first 200 trimmed chars become the halt detail. Same directory and same never-fails `Effect.orElseSucceed(() => "")` read the fork already uses for `<workspaceRoot>/.t3x/resume-prompt.md` (autoResume/config.ts:82-113). The reactor never writes or deletes anything in the user's workspace — staleness is handled by the mtime comparison, so last night's file cannot block tonight's run. (b) PHRASE: the final non-empty line of the newest assistant message from `getThreadDetailById(threadId)` equals the sentinel exactly (default `LOOP-COMPLETE`, per-run overridable). Whole-line equality, not substring, so an agent quoting the protocol mid-paragraph does not trip it.

   Both are ordinary agent output — `Write` a file, or end a message with a word. Neither needs a bespoke tool, an MCP server, or `options.hooks`, so both behave identically if the same repo is driven from a bare `claude` terminal session. The continuation prompt restates BOTH channels verbatim on EVERY iteration, not just the first: a 30-iteration overnight run will compact, and a protocol taught only in iteration 1 is gone by iteration 12.

4. `budget-exhausted` — first true of `spent.iterations >= budget.maxIterations`, `now >= budget.deadlineAtMs`, `now - run.startedAtMs >= budget.maxWallClockMs`, `spent.costUsd >= budget.maxCostUsd`, `ledger.lastContextFraction >= budget.maxContextFraction`. The halt detail names WHICH limit bound and the activity payload carries the full ledger snapshot. The deadline is checked in the tick fiber, not on the turn edge, so a run that goes silent at 03:00 still gets told at 07:00.

5. `no-progress` — `run.consecutiveNoProgress >= stallLimit` (default 3). Incremented when an iteration's turn completes with no `tool.completed`/`task.completed` in the ledger AND a `totalCostUsd` delta below `noProgressCostUsd` (default $0.02) — i.e. the agent replied "ok" and stopped. This is what catches the most likely real-world failure: the agent genuinely finished but never printed the sentinel. It costs ~3 short turns spaced 90s/3m/8m, then halts.

6. `thread-gone` — `threadIsGone(shell)` (deleted / archived / `settledOverride === "settled"`), reusing autoResume/guards.ts:99-103.

### Settings surface

GLOBAL, in `apps/web/src/routes/settings.beta.tsx` — a fork-owned `<LoopBetaSettings />` rendered as a sibling of `<BetaSettingsPanel />`. That file is 11 lines with upstream churn 1; a +2-line edit is a ~risk-2 seam, roughly 500x cheaper than the `SettingsPanels.tsx` anchor (churn 18, existing fork risk 1044) and it needs no `SettingsPath` widening, no `SettingsSidebarNav.tsx` exhaustive-Record edit, and no new route file. The component imports `SettingsPageContainer` / `SettingsSection` / `SettingsRow` from `~/components/settings/settingsLayout` (churn 6, not a seam — free to import) and `Switch` / `Input` from `~/components/ui/*`, copying `BetaSettingsPanel.tsx`'s shape verbatim including its local-draft numeric-input pattern.

Four rows, all backed by a `defaults` key in the fork's own `t3x-loop.json` over `GET/POST /api/coil/loop`, NOT by `ClientSettings` or `ServerSettings`: those schemas silently DROP unknown keys on decode and `writeSettingsAtomically` re-encodes from the decoded value (serverSettings.ts:481), so a smuggled `t3xLoop*` key is physically erased on the next unrelated settings write.
• "Loop continuation (beta)" — the master Switch. Read on every tick, so turning it off stops in-flight runs on every thread within one poll.
• "Default nightly deadline" — `<Input type="time">` defaulting to 07:00, plus a "no deadline" toggle. The BROWSER converts the wall-clock time to the next occurrence in the user's timezone and sends absolute epoch ms; the server never parses "7am" and owns no timezone logic. This is the "stop at 7am" the user actually wants, computed in the only place that knows the answer.
• "Default iteration cap" — number, default 40.
• "Default spend cap (USD)" — number, default 25.

PER-THREAD, in the `LoopOverlay` on the thread route: Start / Stop plus the four budget fields pre-filled from the global defaults. A budget belongs to a RUN and a run belongs to a THREAD, so arming is never a global setting. The global toggle gates; the per-thread control starts.

Both surfaces also register in `apps/web/src/components/settings/settingsSearch.ts` (churn 1) — `to: "/settings/beta"`, which is already in the closed `SettingsPath` union so nothing widens. The same 4-line edit also registers the fork's PRE-EXISTING unregistered `notifyOnNeedsInput` row, closing the silent settings-search gap SEAMS.md:82-86 documents.

### Seam cost

THREE upstream-owned files. Churn measured with the SEAMS.md recipe (`MBTS=$(git show -s --format=%ct $MB); git log --oneline --since="@$((MBTS-60*86400))" $MB -- <path> | wc -l`) against merge-base 64bf01619; recipe validated by ChatView.tsx = 63 matching the doc's self-check.

1. `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — +2 lines (one import, one `<LoopOverlay threadRef={threadRef} />` sibling at line 92 next to the existing `<AutoResumeOverlay>`). Churn 5. Risk 2 x 5 = 10. ALREADY a seam row (current fork Δ +10/-6, risk 80), so this GROWS an existing row rather than adding one.

2. `apps/web/src/routes/settings.beta.tsx` — +2 lines (one import, one `<LoopBetaSettings />` sibling). Churn 1. Risk 2 x 1 = 2. This is a NEW ledger row (row 35) and it trips the SEAMS.md:21-22 tripwire, so it is taken knowingly: it is the cheapest settings mount anywhere in the tree, ~500x cheaper than the SettingsPanels.tsx alternative (a comparable 45-line row there costs 45 x 18 = 810 on top of an existing 1044).

3. `apps/web/src/components/settings/settingsSearch.ts` — +4 lines (SETTINGS_SEARCH_ITEMS entries with `to: "/settings/beta"`, which is already in the closed SettingsPath union so nothing widens and SettingsSidebarNav.tsx's exhaustive Record is untouched). Churn 1. Risk 4 x 1 = 4. This edit is net-positive for the ledger: the same hunk registers the fork's PRE-EXISTING unregistered `notifyOnNeedsInput` row, closing the silent settings-search gap SEAMS.md:82-86 documents as a known defect.

TOTAL ADDED UPSTREAM RISK: 16, across 3 files, +8 lines. One of the three already carries fork lines, and one of the three fixes an existing fork defect.

ZERO cost on the server: the 3-line server.ts seam (import at :59, `Layer.provideMerge(CoilLayerLive)` at :224, `CoilRoutesLive` at :422) does not grow — the reactor merges into `CoilLayerLive` and the route into `CoilRoutesLive` inside the fork-owned `apps/server/src/coil/index.ts` (churn 0). NO contracts edit (no command literal — `thread.turn.start` + `thread.activity.append` already do everything, and `packages/contracts/src/orchestration.ts` at churn 12 is exactly where upstream #5123's `thread.wake-if-idle` and #3164's snooze `condition` field will land). NO migration (highest upstream is 035, a fork 036 collides by number and in the churn-6 registry). NO ClaudeAdapter.ts edit (churn 12). NO ws.ts edit (churn 41). NO ChatView/Sidebar/SidebarV2/index.css edit. NO new route file, so `routeTree.gen.ts` (tracked, generated, churn 5) is untouched.

### Claude Code CLI compatibility

Total, and it is the constraint that shaped the stop condition rather than an afterthought.

THE CONTINUATION IS AN ORDINARY USER TURN. `engine.dispatch({type:"thread.turn.start", ...})` → `ProviderCommandReactor` → `ClaudeAdapter.sendTurn` → `Queue.offer` of a plain `SDKUserMessage` onto the prompt queue the live `query()` is consuming (ClaudeAdapter.ts:3810). That is byte-for-byte the path a keystroke in the composer produces — the fork's auto-resume reactor has been doing exactly this in production since PR #9. Because `systemPrompt: {type:"preset", preset:"claude_code"}` and `settingSources: ["user","project","local"]` are set (ClaudeAdapter.ts:3528-3529), the spawned CLI loads `~/.claude` and `.claude/`, so the user's filesystem hooks, skills, agents and custom slash commands apply to a RUNWAY-issued turn exactly as they do to a terminal one. No provider work is needed: respawn and `--resume` are already handled by the adapter.

THE STOP CONDITION IS EXPRESSIBLE WITH THE CLI'S OWN TOOLS. Channel (a) is `Write`/`echo` to `<workspaceRoot>/.t3x/loop-stop`. Channel (b) is ending a message with a word. Neither requires a bespoke tool the CLI does not have, an MCP server, `options.hooks`, or any T3-specific affordance — which is the literal user constraint. Both work identically in a bare `claude` terminal session on the same repo, so the user's existing `autonomous-build-loop` convention (`.loop/state.json`, `GOALS.md` backlog, `iter-NNN.md` logs) is completely unchanged: RUNWAY replaces only the human who was typing "keep going", and the agent's own protocol files stay authoritative. Reading a file out of the workspace is established fork precedent — auto-resume already reads `<workspaceRoot>/.t3x/resume-prompt.md` (config.ts:82-113), same directory.

NOTHING IS INVENTED IN THE PROTOCOL LAYER. There is no `ScheduleWakeup`, no self-invocation, no new orchestration command literal. The agent CANNOT re-invoke itself across a turn boundary in streaming-input mode, which is exactly why the loop is server-driven; the agent's only job is to do work and, when done, say so in one of two ordinary ways.

PROMPT HYGIENE. The continuation text never begins with `/` (client-side interception is only `^/(plan|default)\s*$` at composer-logic.ts:265, but the CLI itself expands slash commands from the message text, so a leading slash would be a live hazard). The stop protocol is restated on every iteration, so it survives the compactions a 40-iteration overnight run will certainly hit.

DELIBERATELY DEFERRED: the SDK's `Stop` / `SubagentStop` hooks carry a `background_tasks` roster (`BackgroundTaskSummary {id, type: shell|subagent|monitor|workflow, status, description}`) and `session_crons` — strictly better drain signals than the task.started/task.completed pairing with a TTL. They need `options.hooks`, which `ClaudeAdapter` sets nowhere, making it a fresh edit to a churn-12, 3951-line hot upstream file. That is a v2 follow-up gated on a real NDJSON capture (`ClaudeAdapterLiveOptions.nativeEventLogPath`) proving the pairing is actually lossy.

### Why it wins

It answers the question you have to be able to answer before you go to sleep. An idle-timer design answers "is it stuck?" — useful, but it does not tell you when the loop will stop or what it will have cost, so you still cannot leave it. RUNWAY makes the budget the primary object: you arm a run with "40 iterations, $25, stop at 07:00", you get a phone notification at 07:00 saying "23 iterations, $12.40, stopped: deadline", and the ledger is visible in the pill the whole time. That is the difference between a nudge feature and something you actually trust overnight, which is what issue #38 is really asking for.

It converts the two named traps from hazards into solved mechanics rather than caveats. Fact #7 (synthetic turns pin `session.status = "running"` forever) is not worked around by avoiding the status field — it is resolved by noticing that the adapter ALREADY marks synthetic turns on the wire (`raw.method === "claude/synthetic-turn-start"` at ClaudeAdapter.ts:2504, versus the real path emitting no `raw` at all at :3793-3800). That discriminator costs zero seam and is the reason RUNWAY can use the turn edge at all where a status-guard design deadlocks. Fact #8 is not defended against but consciously accepted, with the accounting made steer-safe by charging iterations at dispatch rather than at turn boundaries.

Its trigger is right for the actual bug. Issue #38's thread was marked `completed` while 1,358 activities kept arriving for 33 minutes. A naive turn-edge design fires immediately into live background work; a naive idle timer waits out the whole drain. The quiet window with a `maxDrainMs` cap fires within minutes in both regimes, and because `thread.activity-appended` bumps `projection_threads.updated_at` in both the SQL pipeline and the projector, the fallback path is subagent-aware for free.

It is honest about what stops the loop instead of hoping the budget covers it. Five orthogonal stop reasons — human takeover, blocked-timeout, agent signal, budget, no-progress — each catching a failure the others cannot. `no-progress` in particular catches the most likely real failure (agent finished, forgot the sentinel) at a cost of ~3 short turns rather than 40.

It is cheap and it pays rent. 16 risk points across 3 upstream files and +8 lines, no contracts edit, no migration, no adapter edit, no sidebar edit, no new route, no `routeTree.gen.ts` churn — and one of the three edits fixes an existing documented fork defect (the unregistered settings-search row). When upstream #5123 lands `thread.wake-if-idle`, RUNWAY adopts it as a caller with zero migration, because it never added a command literal to the landing zone.

### Why it might lose

It is more machinery than the bug strictly requires. Issue #38 could be closed by about 60 lines: poll shells, if `now - updatedAt > 20min` and the thread is armed, send "continue". RUNWAY is roughly 1,800 lines including tests, and every one of those lines is fork-owned code someone has to keep alive across syncs. If the user's real complaint is "it went quiet and I had to type", the extra 1,700 lines buy a ledger they might never look at.

The headline is partly a fiction. I claimed "no idle timer as the primary trigger", but the quiet window IS an idle timer — a 45-second one, keyed off ledger events instead of `updatedAt`. And because a mid-real-turn fire is silently absorbed as a steer and synthetic turns muddy the completion edge, the safety net may in practice carry more of the real load than the turn edge does. If it turns out that on issue-38-shaped threads `turn.completed` is unreliable often enough, RUNWAY collapses into an idle-timer design carrying the overhead of a turn-edge design it is not using.

The cost ledger — the thing the whole design is named for — rests on an unvalidated field. `totalCostUsd` comes from `SDKResultSuccess.total_cost_usd`, which nothing in this repo has ever read. If it is absent, zero, or per-session rather than per-turn, the spend budget silently never binds and the user's "$25 cap" is decorative. Same for `maxTokens`, which is optional and without which the context-pressure stop simply does not exist. A design whose selling point is "you can trust it overnight" should not have two of its five limits depending on fields nobody has verified.

The synthetic-turn discriminator is a magic string in a churn-12 upstream file with no upstream contract behind it. `"claude/synthetic-turn-start"` is a debugging label, not an API. When upstream renames it, RUNWAY does not fail loudly — it starts charging phantom turns and arming continuations off subagent chatter, which is a subtly wrong loop rather than a stopped one.

It also takes ledger row 35 despite the SEAMS.md tripwire that says re-isolate before adding one, and the payback offered (registering settings-search entries) fixes a different defect rather than removing a row. A stricter reading of the fork's own doctrine says this design should have found a zero-new-row settings mount or shipped with no settings surface at all.

### Guards

- GLOBAL KILL: `config.enabled` (T3X_LOOP_ENABLED) is read once at layer construction and, if false, the reactor logs and returns before forking either fiber — nothing subscribes at all (autoResume/Reactor.ts:261-264). The web beta toggle is a SEPARATE, live check re-read from the store on every tick, so flipping it off in Settings stops an in-flight overnight run within one poll.
- RUN STATE: `run.state === "running"` is re-read from the durable store inside the tick, not cached from the previous tick, so a Stop pressed in the overlay is honoured within one poll.
- THREAD EXISTS: `Option.isSome(getThreadShellById(threadId))`, else halt `thread-gone` and clear the run.
- THREAD GONE: `threadIsGone(shell)` — `deletedAt !== null || archivedAt !== null || settledOverride === "settled"` (autoResume/guards.ts:99-103).
- IS CLAUDE: `shell.session?.providerName?.toLowerCase() === "claudeAgent".toLowerCase()` (guards.ts:92-96). Non-Claude threads cannot arm a run at all, because the whole cost ledger depends on `SDKResultSuccess.total_cost_usd` which only the Claude path emits.
- SNOOZE (fact #9): if `shell.snoozedUntil` parses to a future instant → SKIP the tick. Do not dispatch, do not halt, do not touch the snooze. `thread.turn.start` unconditionally emits `thread.unsnoozed{reason:"activity"}` (decider.ts:845) with no opt-out, so the only way to respect a snooze is to not dispatch during it. The run resumes on its own once the snooze passes. This is a deliberate divergence from auto-resume, which has no snooze guard.
- KEEP-ACTIVE PIN (fact #9): if `shell.settledOverride === "active"`, dispatch proceeds — but because decider.ts:829 fires `thread.unsettled` for `settledOverride !== null` (destroying the pin, not just a settle), the reactor immediately re-dispatches `{type:"thread.unsettle", reason:"user"}` after the turn start to restore it, and records `pinRestored` on the iteration. One extra command per iteration, zero seam, and the user's explicit pin survives a 40-iteration run.
- BLOCKING REQUESTS: `shell.hasPendingApprovals || shell.hasPendingUserInput` — read off the SQL-backed shell, NOT via a mirror of the decider's private `hasOpenBlockingRequest`. The engine's in-memory read model boots from `getCommandReadModel()` with activities EMPTY (OrchestrationEngine.ts:301, projector.ts:36), so an activity-derived blocking check is unreliable across restarts. Result: pause, escalating to `blocked-timeout` after 30 min.
- USER TAKEOVER: `Date.parse(shell.latestUserMessageAt) > run.lastDispatchAtMs + 2000` → halt.
- SYNTHETIC TURNS (fact #7): `shell.session.status` is read for telemetry and NEVER used as a dispatch gate. A `threadIsProgressing`-style guard would deadlock permanently on exactly the issue-38 threads, because a background subagent's assistant message auto-opens a synthetic turn that pins `session.status = "running"` (ClaudeAdapter.ts:2469-2486) and nothing closes it but a later SDK `result` or the next sendTurn. RUNWAY instead identifies synthetic turns positively at their source — `turn.started` carrying `raw.method === "claude/synthetic-turn-start"` — and excludes only their `turn.completed` from arming and from cost accounting. A synthetic turn is therefore invisible to the trigger rather than fatal to it.
- MID-REAL-TURN FIRE (fact #8): explicitly NOT guarded — see the argument in failureModes; the iteration is still charged to the ledger at dispatch, so a steer costs a real iteration and cannot run away.
- BACKOFF FLOOR: `now - run.lastDispatchAtMs >= gapLadderMs[min(consecutiveNoProgress, 3)]`, ladder `[90s, 3m, 8m, 20m]`.
- RATE-LIMIT DEFERENCE: if `ledger.rateLimitRejected` is set for this thread AND `autoResumeStore.getThread(threadId).pending !== null`, skip. Both fork reactors dispatch `thread.turn.start`; this one read is the only cross-feature coupling, and it closes the 'two mechanisms racing to revive the same thread' hazard issue #38 raises. Wired by providing BOTH module-scope store layers to the loop reactor in t3x/index.ts, relying on the same MemoMap identity trick sharing.test.ts already pins.
- BUDGET: `decideBudget(run.budget, run.spent, ledger, now)` must return `continue` (see stopCondition #4).

### UI surfaces

- `LoopOverlay` (apps/web/src/coil/LoopOverlay.tsx) — mounted as a sibling of `<AutoResumeOverlay>` inside the existing renderState fragment at apps/web/src/routes/\_chat.$environmentId.$threadId.tsx:92. SEAM COST: +2 lines (import + self-closing JSX with a `threadRef` prop) on a churn-5 file that is ALREADY a fork seam row (risk 80), so it grows an existing row by 10 rather than opening a new one. Positioned at `top-[calc(var(--workspace-topbar-height)+2.75rem)] right-3 z-30` so it stacks directly under the auto-resume pill in the same `relative` SidebarInset (ui/sidebar.tsx:629). Collapsed pill: `● Loop 12/40 · $6.20 · ends 07:00`. Dot colour: running `bg-primary`, halted `bg-muted-foreground/40`, >80% of any budget `text-amber-600 dark:text-amber-300` (the explicit-dark-pair convention SidebarV2.tsx:2936-2947 uses for the Snoozed shelf — no new index.css token, that file is churn 38). Expanded panel: Start/Stop, four budget inputs, the live ledger (iterations, spend, elapsed, context %), the last 5 iterations tagged `turn-edge` or `idle-net`, and the halt reason when halted. Data via the fork convention: `ManagedRuntime.make(primaryEnvironmentHttpLayer)` + `resolvePrimaryEnvironmentHttpUrl`, 30s poll + window `focus`, hand-rolled `isJsonObject` parsers, every failure swallowed to `null` so the overlay disappears rather than degrading chat.
- `LoopBetaSettings` (apps/web/src/coil/LoopBetaSettings.tsx) — mounted in apps/web/src/routes/settings.beta.tsx. SEAM COST: +2 lines on an 11-line churn-1 file = risk 2. New ledger row 35.
- Timeline breadcrumbs via `engine.dispatch({type:"thread.activity.append", ...})` with fork-namespaced kinds. SEAM COST: ZERO — `kind` is an open `TrimmedNonEmptyString` and `payload` is `Schema.Unknown` (contracts/orchestration.ts:315-325), and ChatView renders the activity list already. Kinds: `t3x.loop.started` (info, 'Loop armed: 40 iterations, ends 07:00, cap $25'), `t3x.loop.iteration` (info, 'Loop iteration 12/40 · $6.20 spent · 3h 41m left' with the full ledger in payload), `t3x.loop.waiting` (info, edge-detected once per block), `t3x.loop.halted` (info for agent-signalled/budget, error for blocked-timeout/no-progress, carrying the final ledger). Activity commands use the distinct id prefix `t3x-loop-activity:` so they never collide with turn-start command ids, mirroring autoResume/Reactor.ts:76.
- Web Push on halt — reuses `apps/server/src/coil/webPush/send.ts` and the existing `PushSubscriptionStore`. SEAM COST: ZERO (webPush is entirely fork-owned and already in CoilLayerLive). This is the highest-value element in the design: the user asked for overnight autonomy, and what they need at 07:00 is a phone notification saying 'the loop stopped, here is why and what it cost', not to open a laptop and scroll a transcript.
- EXPLICITLY NOT BUILT: no sidebar entry (AppSidebarLayout.tsx churn 15 would be a new row 36; SidebarV2.tsx churn 33 / Sidebar.tsx churn 32 are the worst options in the tree), no new route file (routeTree.gen.ts is tracked+generated, churn 5, mechanical conflict every sync), no ChatView.tsx edit (risk 11466), no WS subscription (the subscribable-method union in client-runtime/src/rpc/client.ts:42-55 is closed).

### New files

- apps/server/src/coil/loop/Reactor.ts — two self-starting scoped fibers (ledger tap on providerService.streamEvents; tick on a pollMs forever-loop) and every dispatch; exports LoopReactorLive = Layer.effectDiscard(makeSupervisor).
- apps/server/src/coil/loop/ledger.ts — pure in-memory per-thread ledger: synthetic-turn tagging from raw.method, open-task set with TTL, cost/token accumulation, quiet-window computation, rate-limit deference flag.
- apps/server/src/coil/loop/decide.ts — pure decideContinuation(): Dispatch | Skip(reason) | Halt(reason); owns the halt ordering, the budget arithmetic and the backoff ladder.
- apps/server/src/coil/loop/guards.ts — shell-typed guards (threadIsGoneShell, isClaudeThreadShell, isSnoozed, userTookOver, isBlocked) plus re-exports from autoResume/guards.ts where the shapes already match; registered as a Logic-mirrors row in SEAMS.md.
- apps/server/src/coil/loop/stopSignal.ts — pure matchesStopSentinel(lastAssistantText, sentinel) (whole-final-line equality) and the never-fails readHaltFile({workspaceRoot, sinceMs}).
- apps/server/src/coil/loop/prompt.ts — builds the continuation text: per-run override → <workspaceRoot>/.t3x/loop-prompt.md → default, always with the two-channel stop protocol appended so it survives compaction.
- apps/server/src/coil/loop/state.ts — versioned JSON store at <stateDir>/t3x-loop.json (runs + global defaults), SynchronizedRef + writeFileStringAtomically, Object.hasOwn lookup (prototype-pollution guard, threadId is caller-controlled), every field withDecodingDefaultKey.
- apps/server/src/coil/loop/config.ts — env-only knobs: T3X_LOOP_ENABLED, \_POLL_MS, \_SETTLE_MS, \_MAX_DRAIN_MS, \_IDLE_GRACE_MS, \_GAP_LADDER_MS, \_BLOCKED_TIMEOUT_MS, \_STALL_LIMIT, \_TASK_TTL_MS, \_SENTINEL.
- apps/server/src/coil/loop/http.ts — GET/POST /api/coil/loop (+ ?threadId), Layer.unwrap so the store requirement never widens upstream's makeRoutesLayer signature, mirrored authenticateWithOperateScope.
- apps/server/src/coil/loop/{ledger,decide,stopSignal,state,http,Reactor}.test.ts — Reactor.test.ts copies the auto-resume harness verbatim: Layer.succeed stubs cast `as unknown as typeof X.Service`, a real store on a temp dir, deterministic Crypto.make, TestClock plus a setImmediate realTick because atomic writes complete on the real event loop.
- apps/web/src/coil/loopClient.ts — the ManagedRuntime + URL builder + hand-rolled parsers shared by the overlay and the settings panel.
- apps/web/src/coil/LoopOverlay.tsx — per-thread pill + expanded run control and ledger.
- apps/web/src/coil/LoopBetaSettings.tsx — the global beta section for /settings/beta.
- docs/coil/loop/DESIGN.md — the decision record, including the synthetic-turn discriminator and the deliberate accept-the-steer argument.

### Failure modes

- TOKEN BURN — steer storm. If the session wedges such that `shell.updatedAt` never advances but dispatches keep landing (each silently absorbed as a steer per fact #8), the idle net re-fires every `idleGraceMs`. Bounded by three independent limits: the gap ladder (90s→3m→8m→20m), the iteration budget (default 40), and `no-progress` (halts after 3 cheap turns). Worst case is roughly 40 short user messages and a few dollars — not an unbounded burn, but this is the design's single largest waste risk and it is bounded only by construction, not by detection.
- TOKEN BURN — sentinel never printed. The most likely real-world failure: the agent genuinely finishes and just stops, without writing `.t3x/loop-stop` or ending with `LOOP-COMPLETE`. RUNWAY then nudges a finished agent. Cost: about 3 short turns spaced 90s/3m/8m before `no-progress` halts it. This is precisely why `no-progress` exists and why it precedes nothing except the budget check — a pure iteration budget would burn all 40.
- FALSE STOP. The agent writes the sentinel as the final line while EXPLAINING the protocol, and the run halts early. Mitigated by whole-final-line equality rather than substring, but not eliminated. Deliberately biased this way: a false stop costs the user one click to restart; a false continue is the 6h50m silence in issue #38.
- INFINITE LOOP — the ping-pong. The agent's continuation reply itself triggers a new `turn.completed`, which arms another continuation, forever. This is the structural infinite loop of any turn-boundary design and the ONLY thing preventing it is the budget ledger being mandatory: a run cannot be created without at least one of maxIterations / deadlineAtMs / maxWallClockMs / maxCostUsd set, enforced at the POST route with a 400. There is no 'unlimited' mode, by design.
- INFINITE LOOP — two reactors. Auto-resume and RUNWAY both dispatch `thread.turn.start`. Handled by the deference read, but the read and the dispatch are not atomic: if auto-resume clears its pending between them, both can fire inside one poll window. Worst case two user messages, the second absorbed as a steer. Bounded, not eliminated.
- LEDGER AMNESIA ON RESTART. Fiber A's map is in-memory and both `providerService.streamEvents` and `engine.streamDomainEvents` are hot-only with no replay. After a restart the committed iterations and spend survive (written durably before each dispatch) but the arming, the open-task set and the synthetic-turn set are lost, so the first post-restart continuation comes from the idle net up to 12 minutes late. Chosen over persisting the hot ledger on every event, which would rewrite the JSON file thousands of times during a subagent storm.
- SYNTHETIC-TURN DISCRIMINATOR IS UNPINNED UPSTREAM. The whole fact-#7 answer rests on `raw.method === "claude/synthetic-turn-start"` (ClaudeAdapter.ts:2504) versus the real path emitting no `raw` at all (:3793-3800). Nothing upstream guarantees that string. If upstream renames it, RUNWAY starts charging phantom turns and arming on subagent chatter — it degrades to a noisy loop, not a silent one. Mitigation: a fork-owned test asserting the literal, and a Logic-mirrors row in SEAMS.md so a sync re-checks it.
- COST LEDGER IS CLAUDE-ONLY AND UNVALIDATED. `totalCostUsd` flows from `SDKResultSuccess.total_cost_usd`, a field the fork has never exercised. If it is absent or zero the spend budget silently never binds and only the iteration/deadline budgets protect the run. Mitigated by refusing to arm runs on non-Claude threads and by requiring at least one non-cost budget.
- CONTEXT-FRACTION STOP CAN BE UNCOMPUTABLE. `ThreadTokenUsageSnapshot.maxTokens` is optional. Without it the fraction is skipped entirely rather than guessed — a silently missing guard, not a wrong one.
- TASK-TTL MISCOUNT. `task.completed` is emitted only from `task_notification` and may never arrive for a task killed by session exit (fact #10). The 15-minute TTL means a genuinely long-running subagent can be evicted from the open-task set, collapsing the drain window and firing a continuation into live background work. That fire is a steer, so it is survivable, but the drain heuristic is the weakest quantitative assumption in the design.
- SUSPEND / CLOCK SKEW. A laptop asleep 02:00–09:00 wakes past a 07:00 deadline; the tick halts immediately with `budget-exhausted (deadline)` and pushes. RUNWAY never 'catches up' missed iterations — correct, but it means an overnight run on a sleeping machine yields nothing and the user learns that only from the halt notification.
- PIN RESTORATION RACE. The keep-active restore is a second dispatch after the turn start. Between them the thread's `settledOverride` is momentarily null and the sidebar may flicker the thread out of its pinned position for one projection tick.
- STALE HALT FILE ACROSS A CLOCK CHANGE. `.t3x/loop-stop` arming uses `mtime >= run.startedAtMs`. A system clock moved backwards between the run start and the file write makes the halt file invisible, and the run continues to its budget. Acceptable: the budget is the backstop.

---

## Night Watch

**Average score: 0/10**

> A watched overnight run becomes a first-class, always-visible object: a pinned Watch Rail at the top of the sidebar with a ten-word live status vocabulary, fed by one fork-owned sampler reactor whose only motion signal is `shell.updatedAt` staleness — so "finished" and "dead" stop looking the same.

### Core mechanism

**The observability object.** A thread becomes a _watched run_ by flipping "Watch this run" in the per-thread overlay (or by the auto-watch rule). Membership is a fork-owned flag in `<stateDir>/t3x-loop.json`, never a new thread kind and never a contracts change — exactly how `apps/server/src/coil/autoResume/state.ts:39-54` already persists a per-thread `enabled` + `overridePrompt` pair. Every watched run gets one durable record: `{watched, watchedAt, startedAtMs, idleAnchorMs, nudgesFiredAtMs[], lastState, progressFingerprint, outcome, lastPushAtMs, budgetOverride}`.

**The sampler.** `apps/server/src/coil/loop/Reactor.ts` self-starts two scoped fibers at layer construction, copying `autoResume/Reactor.ts:266-287` verbatim in shape. Fiber 1 taps `providerService.streamEvents` and maintains a TTL'd open-subagent set from `task.started` / `task.completed` (`ClaudeAdapter.ts:2681-2734`, payloads at `providerRuntime.ts:462-484`), with a 20-minute TTL because `task.completed` is only emitted from `task_notification` and can be lost outright. Fiber 2 ticks every `sampleMs` (default 10s): for each watched thread it does exactly one `snapshotQuery.getThreadShellById(threadId)` (`ProjectionSnapshotQuery.ts:161`) — never `getSnapshot()`, which upstream calls an OOM hazard — computes `phase` via the shared pure `projectThreadAwareness` (`packages/shared/src/agentAwareness.ts:106`), computes `idleMs = now - Date.parse(shell.updatedAt)`, folds in the open-task count and the store record, and runs the pure `classifyWatch()` to produce one `LoopWatchSample`. Samples land in a `SubscriptionRef` (`registry.ts`) that the HTTP route serves without touching SQL.

**Why `updatedAt` is the whole trick.** `thread.activity-appended` bumps `projection_threads.updated_at` in both the SQL pipeline (`ProjectionPipeline.ts:796-808`) and the in-memory projector (`projector.ts:747-750`), and background subagent task activities _are_ activity appends (`ProviderRuntimeIngestion.ts:489/542`). So a plain staleness test is subagent-aware for free: it stays silent through all 1,358 activities of issue #38's turn 31 and goes red at exactly the moment the thread actually died. Crucially, the design reads **no** `session.status` in the stall test. That is deliberate: a background subagent's assistant message auto-opens a synthetic turn that pins `session.status="running"` forever (`ClaudeAdapter.ts:2469-2486`; the only closers are a later SDK `result` or the next `sendTurn`), so auto-resume's `threadIsProgressing` guard (`autoResume/guards.ts:107-111`) would deadlock on precisely the issue-38 threads. `session.status` is used only for _labelling_ (via `projectThreadAwareness`), never for _gating_.

**The rail.** `apps/web/src/coil/loop/WatchRailPortal.tsx` is a headless component mounted once from `__root.tsx`. It resolves `document.querySelector('[data-app-sidebar] [data-slot="sidebar-content"]')` (`ui/sidebar.tsx:704`) and `createPortal`s the `<WatchRail/>` in with `className="order-[-1] sticky top-0 z-10 bg-sidebar"` — landing it at the top of the thread list, below the search chrome, pinned against scroll, in **both** sidebar v1 and v2 because both render `SidebarContent`. It reads `/api/coil/loop` on a 5s poll while any run is non-terminal (30s otherwise, paused on `document.hidden`, refreshed on `focus`), through the fork's standard `ManagedRuntime.make(primaryEnvironmentHttpLayer)` + `resolvePrimaryEnvironmentHttpUrl` path with every failure collapsing to `null` (`AutoResumeOverlay.tsx:47/84-92`) so the rail simply disappears rather than degrading the sidebar. Zero watched runs renders `null` — no footprint for anyone not in the beta.

### Trigger rule

The nudge predicate is evaluated in `decide.ts` (pure) against one `LoopWatchSample` + the store record, and re-evaluated against a **freshly re-read shell** immediately before dispatch (the wake-race close that `autoResume/Reactor.ts:179-182` documents). All of these must hold:

1. `config.enabled === true` AND `config.nudgeEnabled === true` (the beta master switch and the separate intervention switch).
2. `record.watched === true` and `record.outcome === null` (not already done/spent/looping/stopped).
3. `now - record.idleAnchorMs >= config.stallMs` (default 12 min). `idleAnchorMs` is `Date.parse(shell.updatedAt)` whenever `shell.updatedAt` differs from a timestamp this reactor itself caused; see guards.
4. `openTaskCount(threadId, now) === 0` — the TTL'd set from `task.started`/`task.completed`.
5. `shell.hasPendingApprovals === false` AND `shell.hasPendingUserInput === false` (`OrchestrationThreadShell`, `contracts/orchestration.ts:434-435`).
6. `phase !== "failed"` — a failed run is a UI event, never a nudge.
7. `shell.snoozedUntil == null || Date.parse(shell.snoozedUntil) <= now`.
8. `shell.settledOverride === null` — refuses for BOTH `"settled"` and the keep-active `"active"` pin.
9. `shell.archivedAt === null`.
10. `isClaudeThread(shell)` — reuses `autoResume/guards.ts`, not a second mirror.
11. `record.nudgesFiredAtMs.length < budget.maxNudges` (default 12) AND `now - record.startedAtMs < budget.wallClockMs` (default 8h).
12. `now - lastNudgeAtMs >= config.nudgeGraceMs` (default = `stallMs`, so a nudge buys at least one full stall window).
13. `doneMarker(workspaceRoot, record.watchedAt)` is unsatisfied.
14. `record.looping === false` (progress fingerprint changed at least once in the last `loopRepeatN=3` nudges).
15. `autoResumeStore.getThread(threadId).pending === null` — cross-feature guard so the loop reactor and the rate-limit auto-resume reactor never both dispatch `thread.turn.start` into the same thread. Possible only because both stores are module-scope layer values sharing one Effect MemoMap (`t3x/index.ts:80-98`).

Dispatch is a plain `engine.dispatch({type:"thread.turn.start", commandId: CommandId.make(\`t3x-loop:${uuid}\`), threadId, message:{messageId: MessageId.make(\`t3x-loop:${uuid}\`), role:"user", text, attachments:[]}, runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode, createdAt})`. Note we deliberately do **not** try to confirm a new turn started: a `sendTurn` during a real running turn is absorbed as a steer with no new turn id (`ClaudeAdapter.ts:3729-3737`), and both outcomes (steer into a silent live turn, or force-complete a stuck synthetic turn and open a real one) are correct here.

### Stop condition

**A file the agent already writes.** No bespoke tool, no hook, no sentinel token parsed out of assistant prose. `doneMarker.ts` reads, in order, from the thread's `workspaceRoot` (project shell) falling back to `shell.worktreePath`:

1. `<root>/.loop/state.json` — DONE when the parsed JSON has `status` in `{done, complete, completed, finished, blocked}`, **or** `remaining`/`backlog` is an empty array. This is the user's own `autonomous-build-loop` convention verbatim, so an agent following that skill needs zero prompt changes and the identical semantics hold under the bare `claude` CLI.
2. `<root>/.t3x/loop-done` — a plain sentinel file for repos without the loop convention. Its first line, if present, becomes the outcome summary.

**Both are gated on `mtime > record.watchedAt`.** Without that, yesterday's `.loop/state.json` marks tonight's run done at minute one — the single nastiest bug in this design and the one every naive version ships. Parse failure is treated as _not done_ (an agent mid-write must not read as finished), and the file is re-read on every sample tick, so `done` is detected within `sampleMs` of the agent writing it.

Four **terminal** outcomes, all of which stop the watch permanently and all of which are visually distinct in the rail — this is the actual answer to "the user could not tell a finished run from a dead one":

- `done` — marker satisfied. Emerald. `t3x.loop.done` breadcrumb + push.
- `spent` — `nudgesFired >= maxNudges` or `now - startedAtMs >= wallClockMs`. Zinc. This is the honest "I ran out of rope, I do not know if it finished" state, and it must never be dressed up as `done`.
- `looping` — `progressFingerprint` (`latestTurn.turnId + latestTurn.assistantMessageId + checkpoint count`) unchanged across `loopRepeatN = 3` consecutive nudges. Orange, error tone. The anti-token-burn kill switch.
- `stopped` — the user hit "Stop watching", or the thread was archived/deleted.

Anything else (`failed` phase, `blocked`) is **non-terminal**: the run stays watched and visible, because a failed overnight run is exactly what you want still sitting in the rail at 8am.

### Settings surface

**Mount:** `apps/web/src/routes/settings.beta.tsx` (11 lines, churn **1**) — the cheapest settings mount in the tree by two orders of magnitude. `SettingsBetaRoute` wraps its body in a fragment and renders a fork-owned `<LoopWatchSettingsSection />` as a sibling of `<BetaSettingsPanel />`. Measured cost: +5/-1 lines x churn 1 = **risk 5**. Compare `SettingsPanels.tsx` (churn 18, already risk 1044; another 45-line row = +810) and `BetaSettingsPanel.tsx` (churn 3, and it would put fork-owned JSX inside an upstream panel body). No settings-nav entry is needed — `/settings/beta` is already in `SETTINGS_SECTION_LABELS`. `searchableSetting()` is skipped (its id union is closed); rows pass plain `id`/`title`, matching what the fork's `notifyOnNeedsInput` row already does.

`LoopWatchSettingsSection` imports `SettingsPageContainer` / `SettingsSection` / `SettingsRow` from `~/components/settings/settingsLayout` (churn 6, **not** a seam — free to import) and `Switch` / `Input` / `Textarea` from `~/components/ui/*`. It reads and writes `/api/coil/loop` over `primaryEnvironmentHttpLayer`; if the route 404s (older server) the whole section renders `null`, so the beta page degrades to upstream's exactly.

**All settings here are GLOBAL, server-scoped, and persisted in `<stateDir>/t3x-loop.json` — zero `packages/contracts/src/settings.ts` edit (churn 18, and it is a persisted schema where a bad add is a data problem, not a rebase problem):**

- **"Watch overnight runs (beta)"** — master. Off ⇒ reactor short-circuits at layer construction (`autoResume/Reactor.ts:261-264` pattern), rail renders `null`, no samples, no pushes, no nudges.
- **"Nudge stalled runs"** — default **OFF**. Separates seeing from intervening. This is the most important row on the page.
- **"Stall after"** — minutes, default 12. Direct visual precedent: `sidebarAutoSettleAfterDays`'s `AutoSettleDaysInput` (`BetaSettingsPanel.tsx:17-56`).
- **"Nudge budget per run"** — default 12. **"Stop after"** — hours, default 8.
- **"Watch new Claude threads automatically"** — default off; when on, any Claude thread whose current turn exceeds `autoWatchAfterMinutes` (default 20) is auto-watched.
- **"Done marker"** — read-only display of the two accepted paths plus an editable extra path relative to `workspaceRoot`.
- **"Nudge message"** — textarea, default `continue`; overridden per-workspace by `<root>/.t3x/loop-nudge.md` if present, mirroring the existing `.t3x/resume-prompt.md` precedent.
- **"Phone alerts"** — which loop events push: stalled / done / spent / looping, plus a cooldown (default 15 min).

**PER-THREAD** state lives only in the thread overlay and the rail row menu, never in settings: watched on/off, per-run budget override, "Nudge now", "Mark done", "Unpin & nudge", "Stop watching".

### Seam cost

Churn re-measured in this session against merge-base `64bf0161919ec0e41470af3304928d9fc8711bf4` using SEAMS.md's own recipe (`git log --oneline --since="@$((MBTS-60*86400))" $MB -- <path> | wc -l`).

**Upstream-owned files edited — three, one of them a new row:**

| File                                                     | Fork Δ (existing → after)                                      | churn | risk (before → after) | Δ risk | New row?         |
| -------------------------------------------------------- | -------------------------------------------------------------- | ----- | --------------------- | ------ | ---------------- |
| `apps/web/src/routes/__root.tsx`                         | +6 → +7 (one `<WatchRailPortal/>` line)                        | 9     | 54 → 63               | **+9** | no (row exists)  |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` | +10/-6 → +10/-6 (1-for-1 rename of the import and the JSX tag) | 5     | 80 → 80               | **0**  | no (row exists)  |
| `apps/web/src/routes/settings.beta.tsx`                  | 0 → +5/-1 (fragment + import + `<LoopWatchSettingsSection/>`)  | 1     | 0 → 5                 | **+5** | **YES — row 35** |

**Total: Δ risk +14. Ledger rows 34 → 35.** The new row would be the second-lowest-risk row on the entire ledger (current minimum is 1). `apps/server/src/coil/index.ts` gains 4 lines but is fork-owned, churn 0, and not a seam — the 3-line `server.ts` seam (risk 87) is untouched, which is the aggregator working exactly as designed. `packages/contracts/**` is untouched: no command literal, no settings field, nothing in the `orchestration.ts` (churn 12) zone where #5123 and #3164 will collide. `apps/server/src/provider/Layers/ClaudeAdapter.ts` (churn 12) is untouched: no `options.hooks`, no Stop/SubagentStop, no `background_tasks`. `apps/web/public/sw.js` is untouched. No migration (`Migrations.ts` churn 6, and 036\_\* would collide by number). No new route file, so `routeTree.gen.ts` (tracked, generated, churn 5) never regenerates.

**Tripwire compliance.** SEAMS.md:21-22 says "before adding row 35, re-isolate something instead." The row being added is the +5 settings mount, which exists only because the user explicitly asked for a settings toggle — and it is the cheapest such mount in the tree. The re-isolation offered in return is a follow-up PR (spec'd, not required for v1): `apps/web/src/coil/index.tsx` exporting a single `<CoilRoot/>` that renders `NotificationCoordinator`, `ThreadOutboxDrain`, `PushSubscriptionManager` and `WatchRailPortal`, collapsing `__root.tsx` from +7 fork lines to +2 — risk 63 → 18, a **-45** swing that leaves the ledger's total risk lower than before this feature landed.

**The sidebar argument — why I did NOT take `AppSidebarLayout.tsx:203`.** It is the obvious choice: one import + one JSX sibling reaching v1, v2 and the mobile Sheet, at 2 lines x churn 15 = **risk 30**, which would rank 30th of 36. I reject it for two concrete reasons, not for tripwire piety. (1) **It cannot deliver the placement the user asked for.** `<Sidebar>`'s children render into a `flex h-full w-full flex-col` (`ui/sidebar.tsx:309`); placing the rail _after_ line 203's expression docks it at the sidebar's bottom (because `SidebarContent`'s ScrollArea is `flex-1`), and placing it _before_ puts it above `SidebarChromeHeader`, displacing the macOS traffic-light inset and the Electron drag region. The portal lands it exactly where the user described — top of the thread list, below the search box, `sticky` so it never scrolls away. (2) **The one real objection to the portal is fully neutralizable.** The research calls the portal's failure mode "silent"; `WatchRailPortal.contract.test.tsx` renders `AppSidebarLayout` and asserts `[data-app-sidebar] [data-slot="sidebar-content"]` resolves, so an upstream rename fails red at sync time instead of vanishing. With that test, the portal's residual risk is a red test versus the seam's guaranteed +30 and permanent row 36. **Escape hatch, fully spec'd:** if the portal proves flaky in practice, swap `WatchRailPortal` for a direct `<WatchRail/>` sibling after `AppSidebarLayout.tsx:203` (accepting bottom-dock placement), delete the portal file and the contract test, and add the row: +2 lines x 15 = +30, total Δ +44, rows 34 → 36. One commit, no other file changes.

**Rejected alternatives, priced:** editing `SidebarV2.tsx` (~40 lines x 33 = **1320**, and misses v1 entirely); a settings row in `SettingsPanels.tsx` (45 lines x 18 = **+810** on top of an already-1044 row); a `thread.wake-if-idle` command literal in `contracts/orchestration.ts` (~15 x 12 = **180** plus an unreported semantic collision with upstream #5123); an RPC method in `ws.ts` (6 x 41 = **246**); a WS subscription (forces `contracts/rpc.ts`, churn 15).

### Claude Code CLI compatibility

Nothing in this design requires a capability the Claude Code CLI does not have, and nothing requires an edit to `ClaudeAdapter.ts`.

**The nudge is an ordinary user turn.** `engine.dispatch({type:"thread.turn.start", ...})` with `runtimeMode` and `interactionMode` taken from the thread itself — byte-for-byte the path a keystroke produces, as `autoResume/Reactor.ts:100-123` already proves in production. The SDK sees a plain `SDKUserMessage` on the existing streaming-input session; provider respawn and `--resume` are already the adapter's job. No `ScheduleWakeup`, no self-invocation, no tool the CLI lacks.

**The stop condition is a file.** `.loop/state.json` (the user's own `autonomous-build-loop` convention) or `.t3x/loop-done`, both written with plain `Write`/`Edit`. An agent already following that skill needs zero prompt changes; an agent that is not can be told about it in one sentence. The same repo run under bare `claude` produces the identical marker, so the semantics do not depend on T3 at all — T3 only adds the watching and the nudging. This deliberately avoids the alternative of parsing a sentinel token out of assistant prose, which would need message bodies the cheap `getThreadShellById` read does not carry.

**The nudge text is a file too.** `<workspaceRoot>/.t3x/loop-nudge.md` if present, else the configured string, else `continue`. Direct precedent: the fork already reads `<workspaceRoot>/.t3x/resume-prompt.md` for auto-resume (`autoResume/config.ts`).

**Subagent awareness uses only what the SDK already emits.** `task.started` / `task.completed` (`ClaudeAdapter.ts:2681-2734`) plus the free `updatedAt` bump from activity appends. Explicitly NOT used, and deferred as follow-ups: `options.hooks` (the adapter sets none anywhere — a fresh edit to a churn-12 hot file), `StopHookInput.background_tasks`, `SubagentStop`, `session_crons`, `is_backgrounded` (unavailable — `task_updated` is swallowed at ClaudeAdapter.ts:2716), and `event.raw.payload.subagent_type` (available, but not needed for v1's counting).

**No new contract vocabulary.** Only `thread.turn.start` and `thread.activity.append`, both existing literals. When upstream lands #5123's `thread.wake-if-idle`, Night Watch adopts it as a caller with a one-line change and zero migration; when #3164's automations land, nothing here has claimed the name, the directory, or migration 036.

### Why it wins

It attacks the half of issue #38 that actually cost the user the night. The mechanism half — "re-prompt a stalled thread" — is genuinely easy: `updatedAt` staleness plus `thread.turn.start`, forty lines. What the transcript actually shows is a human polling a UI that could not distinguish "finished at 00:19" from "dead since 00:52", twice, six hours apart, and typing "You stopped again" as the only available instrument. Night Watch makes that state legible in one glance, from the sidebar, from the lock screen, without opening the thread — and it does so with an intervention layer that is **off by default**, so the visibility is usable even by someone who never wants a server typing into their session.

It is also the cheapest design on the ledger. Measured: **+14 risk, one new row at risk 5.** No contracts edit, no adapter edit, no migration, no route file, no `routeTree.gen.ts` regeneration, no `ws.ts`, no `SettingsPanels.tsx`, no sidebar-component edit. The `_chat` route seam grows by exactly zero lines because the new per-thread control mounts through a fork-owned wrapper that replaces the existing `<AutoResumeOverlay>` tag one-for-one. The phone path costs zero new client code because `sw.js` already renders generic `title`/`body`/`key` payloads and routes clicks by `environmentId`/`threadId` — the fork's Web Push investment is reused rather than re-forked, sharing one subscription store through the MemoMap identity trick `t3x/index.ts:80-98` already documents.

And it is correct about the two traps that sink the obvious implementations. It never reads `session.status` as a gate, so the synthetic-turn deadlock (`ClaudeAdapter.ts:2469-2486`) that would freeze any `threadIsProgressing`-based design on exactly the issue-38 threads simply does not exist here. It refuses to fire on `snoozedUntil` and on **both** values of `settledOverride`, because `decider.ts:829-857` destroys the keep-active pin with no opt-out — and rather than failing silently, it renders the refusal as a labelled row in the rail with a one-click override. That is the same discipline applied to the observability layer as to the mechanism: every state the server is in, the user can see.

### Why it might lose

The honest case against it:

**It is mostly UI.** Six of the ten new web files are presentation. A reviewer who reads issue #38 as "the loop stopped looping" will see a status vocabulary where they wanted a control loop, and the actual supervisor here is deliberately minimal — a sampler plus a fifteen-clause predicate. A competing design that spends its whole budget on the mechanism (Stop-hook `background_tasks`, a real turn-completion contract, cron-style pacing) will look more like an answer to the stall and less like a dashboard for it.

**The portal is the one genuinely soft part.** Every other piece of this design is a compile-time or type-checked dependency; `document.querySelector('[data-app-sidebar] [data-slot="sidebar-content"]')` is a string. The contract test converts silent breakage into a red test on the desktop tree, but it does not cover the mobile Sheet, and a reviewer who has been burned by DOM-coupled forks will prefer the honest +30-risk seam at `AppSidebarLayout.tsx:203` and accept a bottom dock. That is a defensible read and I have priced the swap, but I chose against it.

**Ten states is a lot of vocabulary.** `quiet` versus `stalled` versus `nudging` is a distinction a tired user at 8am may not want to make; a three-state design (running / needs you / finished-or-dead) could read faster and be a better product even though it carries less information.

**The stop condition is a convention, not a contract.** It works perfectly for this user, whose `autonomous-build-loop` skill already writes `.loop/state.json` — and degrades to "terminated at budget, outcome unknown" for anyone else. A design whose done-signal is intrinsic to the harness would not have that cliff.

**Collision timing.** Upstream #3164 ("Automations & Triggers (for loops)") is 🚧 In Progress and is landing in `apps/web`. A pinned sidebar section is the single most likely thing in this design to be visually and conceptually superseded within a release, which makes the UI investment the part most at risk of becoming an unwind rather than a delete.

### Guards

- Synthetic turns: `session.status` is NEVER read in the stall test or any gate. It is used only by `projectThreadAwareness` for the display label. A thread stuck at `session.status="running"` because of an unclosed synthetic turn (ClaudeAdapter.ts:2469-2486) still classifies as `stalled` on `updatedAt` age and still nudges — the deadlock in auto-resume's `threadIsProgressing` (guards.ts:107-111) is designed out, not worked around.
- Snooze: refuse to nudge while `shell.snoozedUntil` is in the future. `thread.turn.start` unconditionally emits `thread.unsnoozed(reason:"activity")` (decider.ts:845-857) with no opt-out, so the only safe move is not to fire. The rail surfaces the refusal explicitly — `"paused · snoozed until 07:00"` — so a watched run that never nudges is explained rather than mysterious.
- Settled + keep-active pin: refuse to nudge whenever `shell.settledOverride !== null`, i.e. for BOTH `"settled"` and the explicit keep-active `"active"` pin. decider.ts:829-841 unsettles for `settledOverride !== null`, so a nudge would silently destroy a user's deliberate pin. The rail shows `"paused · pinned"` with a one-click "Unpin & nudge" that the user, not the server, triggers.
- Blocking requests: `hasPendingApprovals` / `hasPendingUserInput` both hard-block a nudge. A run waiting on a permission prompt is `blocked`, not `stalled`, and gets the amber/indigo needs-you treatment plus the existing webPush attention path rather than a nudge.
- Failed phase: `phase === "failed"` blocks the nudge. Re-prompting a thread whose session errored burns tokens against a broken session; it surfaces as a rose `failed` row instead.
- Open subagents: `openTaskCount(threadId, now) > 0` blocks. Belt-and-braces on top of the `updatedAt` signal, with a 20-minute TTL per task because `task.completed` fires only from `task_notification` (ClaudeAdapter.ts:2716) and `task_updated` / `background_tasks_changed` are explicitly swallowed — an unpaired `task.started` must not wedge the watch forever.
- Self-bump: our own `thread.activity.append` breadcrumbs bump `updatedAt` (ProjectionPipeline.ts:796-808) and would reset the stall clock. Guarded two ways: breadcrumbs are emitted ONLY on a state transition (edge-detected exactly like `webPush/attention.ts:66-82`), never on a repeat sample; and the reactor records the ISO timestamps of its last 3 self-dispatches, and `idleAnchorMs` refuses to advance to a `shell.updatedAt` matching one of them.
- Cross-reactor: refuse while `autoResumeStore.getThread(threadId).pending !== null`, so a rate-limited overnight run is not woken twice by two fork reactors racing on the same thread.
- Wall-clock jump (laptop sleep): if the gap between sample ticks exceeds `3 x sampleMs`, `idleAnchorMs` is re-anchored to `now` and the tick is skipped. Otherwise a lid-open at 9am fires an instant nudge into every watched run at once.
- Budgets, re-checked at dispatch time: `nudgesFired < maxNudges` (12) and `now - startedAtMs < wallClockMs` (8h). Both re-read from the store immediately before dispatch, and the fire is recorded BEFORE dispatch (autoResume/Reactor.ts:228-231's reservation pattern) so a dispatch failure cannot tight-loop.
- Grace: `now - lastNudgeAtMs >= nudgeGraceMs` (default equal to `stallMs`), so a nudge always buys a full stall window before another can fire even if the agent produces nothing at all.
- Done-marker staleness: marker `mtime` must be strictly greater than `record.watchedAt`; a malformed `.loop/state.json` reads as not-done.
- Provider: `isClaudeThread(shell)` (`session?.providerName === "claudeAgent"`), imported from `autoResume/guards.ts` rather than re-mirrored — SEAMS.md warns two independent mirrors of one private upstream helper is strictly worse than one shared mirror.
- Intervention opt-out: `config.nudgeEnabled` defaults to FALSE. Turning the beta on gives you the whole observability surface with the server never typing into a thread. Nudging is a second, explicit consent.

### UI surfaces

- **The Watch Rail** (`apps/web/src/coil/loop/WatchRail.tsx`) — the pinned sidebar section. A `SidebarGroup`-shaped block: a header row `WATCHING (3)` in `text-sidebar-muted-foreground` with a collapse chevron and an aggregate dot (worst state wins, same precedence as `resolveProjectStatusIndicator`), then one compact row per watched run. Each row: project title dimmed, thread title truncated, and the status line — `<dot> <state label> · <age>` — plus a right-aligned budget chip `3/12` while nudging is on. Row surfaces copy SidebarV2 verbatim (`SidebarV2.tsx:695-708`): `bg-sidebar-row-active` when the run needs you, `bg-sidebar-row-selected` when it is the open thread, `hover:bg-sidebar-row-hover` otherwise, on `rounded-md text-left select-none`. Renders `null` at zero watched runs. Seam cost: **0** (fork-owned file).
- **The mount** (`apps/web/src/coil/loop/WatchRailPortal.tsx`) — headless, renders `null`, added as one JSX line in `apps/web/src/routes/__root.tsx` beside `<PushSubscriptionManager/>`. It resolves `[data-app-sidebar] [data-slot="sidebar-content"]` (`ui/sidebar.tsx:704`) on mount and on a `MutationObserver` (the sidebar mounts after root, and the mobile Sheet unmounts/remounts), then `createPortal`s `<WatchRail/>` with `order-[-1] sticky top-0 z-10 bg-sidebar` so it sits at the TOP of the thread list, below the search chrome, and does not scroll away. Works in v1, v2 and the mobile Sheet without knowing which is rendered. Seam cost: +1 line on an EXISTING row (`__root.tsx`, +6→+7, churn 9) = **+9 risk, no new row**.
- **Status vocabulary** (`apps/web/src/coil/loop/watchVocabulary.ts`, pure, mirrored by the server's `classify.ts`) — ten states, deliberately reusing `resolveThreadStatusPill`'s exact color language (`Sidebar.logic.ts:565-645`) so the rail reads as native: `working` sky+pulse "Working 41m"; `delegating` sky+pulse "3 subagents · 41m"; `blocked` amber "Needs approval" / indigo "Needs input"; `quiet` slate "Quiet 4m"; `stalled` rose "Stalled 41m"; `nudging` violet "Nudged · waiting 2m"; `looping` orange "Looping x3"; `spent` zinc "Budget spent 12/12"; `done` emerald "Done 03:14 · 7 nudges"; `failed` destructive "Failed". Ages use upstream's own `formatWorkingDurationLabel` (`Sidebar.logic.ts:565`). Seam cost: **0**.
- **Per-thread control** (`apps/web/src/coil/loop/WatchThreadPill.tsx` inside a fork-owned `ThreadOverlays.tsx`) — a second pill stacked under the auto-resume pill in the SAME floating column at `top-[calc(var(--workspace-topbar-height)+0.5rem)] right-3 z-30`. Collapsed: `<dot> Stalled 41m · 3/12`. Expanded: watch switch, nudge switch, live idle age, budget bars, the resolved done-marker path with a live tick/cross, and buttons Nudge now / Mark done / Stop watching. Mounted by RENAMING the existing seam line in `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:92` from `<AutoResumeOverlay threadRef={threadRef} />` to `<CoilThreadOverlays threadRef={threadRef} />` (and the matching import). Seam cost: **0 added lines, 0 new rows** — a 1-for-1 identifier swap on an existing row.
- **Timeline breadcrumbs** — `engine.dispatch({type:"thread.activity.append", ...})` with `id: EventId.make(\`t3x-loop:${uuid}\`)`, emitted on state TRANSITIONS only: `t3x.loop.watch.started`(info, states the whole contract: stall window, budget, done marker path),`t3x.loop.stalled`(info),`t3x.loop.nudged`(info, "Nudge 3/12 sent after 14m of silence"),`t3x.loop.blocked`(info),`t3x.loop.looping`(error),`t3x.loop.spent`(error),`t3x.loop.done`(info, with elapsed + nudge count),`t3x.loop.watch.stopped`(info). Every append is best-effort and`catchCause`d so a breadcrumb failure never fails a nudge (`autoResume/Reactor.ts:89-98`). Seam cost: **0** — `thread.activity.append` is an existing command literal.
- **Phone** (`apps/server/src/coil/loop/notify.ts`) — reuses the fork's existing `PushSubscriptionStore`, `WebPushVapid` and `sendWebPush` through the same module-scope `WebPushDepsLive` value in `t3x/index.ts:64`, so one subscription list serves both features. Payload is `AttentionPushPayload`-shaped (`webPush/attention.ts:20-27`) with `kind` extended to `loop_stalled | loop_done | loop_spent | loop_looping`, and `key: \`loop::${env}::${threadId}\``. **`apps/web/public/sw.js`needs ZERO changes** — it already renders`title`/`body`/`key`generically with`renotify`, and `notificationclick`already routes on`environmentId`/`threadId`. One live lock-screen notification per run, replaced in place as the state changes; capped at one push per thread per `pushCooldownMs`. `blocked`pushes are suppressed because the existing`WebPushReactor`already covers`waiting\_\*` edges — no doubling. Seam cost: **0**.
- **In-page** — when a tab is open, sw.js suppresses push by design (`sw.js:38-42`). The rail plus a single anchored toast on the `stalled` and `done` transitions (via `toastManager`, already imported by `NotificationCoordinator.tsx:3`) covers that case. Seam cost: **0**.

### New files

- apps/server/src/coil/loop/config.ts — env-sourced defaults + pure `resolveConfig` (T3X_LOOP_ENABLED, sampleMs, stallMs, budgets), mirroring autoResume/config.ts
- apps/server/src/coil/loop/state.ts — `LoopStore` Context.Service over `<stateDir>/t3x-loop.json` (global settings + per-thread records), SynchronizedRef + atomicWrite, `withDecodingDefaultKey` on every field
- apps/server/src/coil/loop/classify.ts — PURE `classifyWatch(shell, phase, openTasks, record, config, nowMs) => LoopWatchSample`; the single source of the ten-state vocabulary
- apps/server/src/coil/loop/decide.ts — PURE `decideAction(sample, record, config, nowMs) => idle | nudge | finish | terminate | breadcrumb`
- apps/server/src/coil/loop/guards.ts — `nudgeBlockedReason(shell, record, autoResumePending, nowMs)` returning a human string for the rail; imports `isClaudeThread` from autoResume/guards rather than re-mirroring it
- apps/server/src/coil/loop/doneMarker.ts — reads `.loop/state.json` and `.t3x/loop-done` under workspaceRoot, mtime-gated on watchedAt, tolerant parse
- apps/server/src/coil/loop/tasks.ts — TTL'd open-subagent set fed by task.started / task.completed
- apps/server/src/coil/loop/progress.ts — progress fingerprint (turnId + assistantMessageId + checkpoint count) for looping detection
- apps/server/src/coil/loop/registry.ts — `SubscriptionRef<ReadonlyArray<LoopWatchSample>>` so the HTTP route never re-queries SQL
- apps/server/src/coil/loop/notify.ts — loop push payloads over the shared PushSubscriptionStore / WebPushVapid / sendWebPush
- apps/server/src/coil/loop/Reactor.ts — the two self-starting scoped fibers (task-stream tap, sample tick) + breadcrumb and turn dispatch
- apps/server/src/coil/loop/http.ts — GET/POST `/api/coil/loop`, `Layer.unwrap` store resolution copied verbatim from autoResume/http.ts:160
- apps/server/src/coil/loop/{classify,decide,doneMarker,tasks,guards,progress,state,http,Reactor}.test.ts — nine specs, all in the fork-owned directory (never appended to an upstream describe)
- apps/web/src/coil/loop/api.ts — ManagedRuntime + resolvePrimaryEnvironmentHttpUrl client with hand-rolled parsers, every failure to null
- apps/web/src/coil/loop/useLoopWatch.ts — adaptive-interval poll hook (5s hot / 30s cold / paused when hidden / refresh on focus)
- apps/web/src/coil/loop/watchVocabulary.ts — PURE state → {label, colorClass, dotClass, pulse}
- apps/web/src/coil/loop/WatchRail.tsx — the pinned sidebar section
- apps/web/src/coil/loop/WatchRailPortal.tsx — headless portal mounter + MutationObserver retry
- apps/web/src/coil/loop/WatchThreadPill.tsx — per-thread live state + controls
- apps/web/src/coil/ThreadOverlays.tsx — fork-owned wrapper rendering AutoResumeOverlay + WatchThreadPill in one column
- apps/web/src/coil/loop/LoopWatchSettingsSection.tsx — the beta settings section
- apps/web/src/coil/loop/{watchVocabulary,api,useLoopWatch}.test.ts + WatchRailPortal.contract.test.tsx — the last one renders AppSidebarLayout and asserts the portal selector resolves, turning silent breakage into a red test

### Failure modes

- **Token burn — nudging into real work.** A run doing a genuinely silent 20-minute operation (a long `pnpm test`, a slow `WebFetch`) with no subagent tasks open reads as `stalled`, and the nudge is absorbed as a steer into the live turn (ClaudeAdapter.ts:3729-3737), re-reading context and possibly derailing it. Mitigated by `stallMs` defaulting to 12 min, by the open-task check, and decisively by `nudgeEnabled` defaulting to FALSE — the beta ships as pure observability until you opt into intervention.
- **Infinite loop — nudge, 'continuing!', nothing, nudge.** The classic autonomous-loop death spiral, and the reason a bare stall detector is dangerous. Detected by `progressFingerprint` (turnId + assistantMessageId + checkpoint count) being unchanged across 3 consecutive nudges ⇒ state `looping`, watch terminates, error breadcrumb + push. Backstopped unconditionally by 12 nudges and 8 wall-clock hours. Worst case cost is bounded at 12 short turns per run.
- **Stale done marker.** A `.loop/state.json` left at `status: done` from last night marks tonight's run finished at minute one and the watch silently stops. Mitigated by requiring `mtime > record.watchedAt` — but if the agent's very first act is to rewrite that file with the old status, the run reads done anyway. Residual; the rail's `done` row shows the marker path and mtime so it is at least inspectable.
- **Never-done runs.** An agent that ignores the file convention entirely always terminates as `spent`, not `done`. This is intentional honesty, not a bug — but it means the design's headline benefit (telling finished from dead) degrades to 'telling stopped-by-budget from dead' for repos that do not adopt the marker.
- **Self-bump feedback.** Our own breadcrumbs bump `projection_threads.updated_at`, so a chatty reactor would reset its own stall clock forever. Guarded by transition-only emission plus a self-caused-timestamp skiplist. Residual: a run oscillating between `blocked` and `quiet` emits alternating breadcrumbs that keep pushing `idleAnchorMs` forward. Bounded because `blocked` is a non-firing state anyway, but it can delay a legitimate stall detection by minutes.
- **Unpaired `task.started`.** `task.completed` is only emitted from `task_notification` (ClaudeAdapter.ts:2716); `task_updated` and `background_tasks_changed` are swallowed. A task killed by session exit never notifies, so without the 20-minute TTL the open-task set wedges the watch permanently. With the TTL, the inverse risk appears: a genuinely long subagent past 20 minutes is forgotten and the parent can be nudged mid-delegation. `updatedAt` staleness is the backstop (a live subagent is still appending activities), so both failures need to coincide.
- **Portal target vanishes.** If upstream renames `data-slot="sidebar-content"` the rail disappears with no error. Converted from silent to loud by `WatchRailPortal.contract.test.tsx`. If upstream restructures the mobile Sheet, the rail can be missing on phones while present on desktop — the contract test covers only the desktop tree.
- **Phone gap by design.** `sw.js:38-42` suppresses push whenever ANY tab is open. A laptop with a T3 tab open at 3am means no phone alert for a stall. Inherited from the existing needs-input de-dup contract; accepted as a v1 edge rather than doubling notifications.
- **Poll cost.** 5s polling of `/api/coil/loop` from every open tab. Bounded because the route reads a `SubscriptionRef` with zero SQL, the client backs off to 30s when nothing is non-terminal, and pauses on `document.hidden`. Still worse than a WS push — which is unavailable because `EnvironmentSubscriptionRpcTag` is a closed union (`client-runtime/src/rpc/client.ts:42-55`).
- **Sampler cost.** One `getThreadShellById` per watched thread per 10s. At 20 watched runs that is 2 single-row reads/sec — negligible, and explicitly never `getSnapshot()`, whose per-tick use in `autoResume/Reactor.ts:155/182` is the fork's known OOM hazard. This design does not fix that existing hazard; it only refuses to add to it.
- **Two reactors, one thread.** Auto-resume and Night Watch both dispatch `thread.turn.start`. The cross-store guard prevents the double-fire, but nothing prevents auto-resume from firing one second after Night Watch marked a run `spent` — the run gets resumed with no watch on it and disappears from the rail while still burning tokens.
- **Vocabulary overload.** Ten states may be more than a person absorbs at 8am. Mitigated by collapsing to three color families (needs-you amber/indigo, in-motion sky/violet, terminal emerald/rose/zinc/orange) and by the rail header showing a single worst-state dot when collapsed.
- **Beta scope.** `t3x-loop.json` is per-server-instance. A user running two T3 servers gets two independent watch sets and two independent beta toggles, with no UI hinting at that.
