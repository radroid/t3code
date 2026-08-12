# Loop Watch — design (radroid/t3code#38)

> **Status: designed, not built.** No `apps/server/src/coil/loop/` exists — every path this
> document writes in the present tense is a proposal. It is archived here because the research
> underneath it is reusable, not because the feature shipped.
>
> Two things have moved since 2026-08-02 and must be re-checked before anyone builds from it.
> Upstream #5219 supersedes the subagent-tracking gap that motivated the issue, and upstream
> PR #3638 ships `schedule_task` / `delegate_task` MCP tools. The codebase line numbers cited
> throughout were measured against the 2026-08-02 merge-base and have since drifted through
> several upstream syncs — re-verify each one rather than trusting it.

_Chosen 2026-08-02 from a 4-design / 12-judgement panel. Full alternatives in [OPTIONS.md](OPTIONS.md); codebase evidence in [RESEARCH.md](RESEARCH.md)._

**Winner:** quiescence — "Deadman", shipped as **Loop Watch** (`apps/server/src/coil/loop/`), with grafts from RUNWAY (visible mandatory budget + wall-clock deadline), Night Watch (honest terminal-state vocabulary, phone push), and BATON (scheduler-ownership line in the prompt, sticky human-cleared park).

## Ranking

| Design                      | Avg  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quiescence (Deadman)        | 7.67 | WINNER. The only design with zero fatal flaws across all three lenses. Its trigger — `now - projection_threads.updated_at` — is the one signal every one of the twelve judgements independently named as the best idea worth stealing. I re-verified it: ProjectionPipeline.ts:794-808 groups `thread.activity-appended` with `thread.message-sent` and rewrites the row with `updatedAt: event.occurredAt`, and |
| budget (RUNWAY)             | 6.33 | Headline mechanism is dead; its product instinct survives. I confirmed the SRE's kill shot: `stopSessionInternal` calls `completeTurn(context, "interrupted", "Session stopped.")` at ClaudeAdapter.ts:3057, emitting a real-turnId `turn.completed`, so arming on any non-synthetic turn.completed restarts exactly the work the user just hit Stop on. I also confirmed the second hole at ClaudeAdapter.ts:19 |
| observability (Night Watch) | 6.33 | Right diagnosis, two mechanisms that do not exist. I read the user's own template at /Users/rajdholakia/.claude/skills/auto-loop-bootstrap/assets/templates/.loop/state.json: it is `{stage, iter, pr_mode, pr_size_policy, base_branch, backlog_source}` — there is no `status` key and no `remaining`/`backlog` array, and the companion CLAUDE.md:50 says outright `The loop NEVER halts on a semantic event` |
| contract (BATON)            | 6    | Loses on three independently-verified defects, all in the load-bearing mechanism. (1) The contract is read from the wrong directory on most threads: `resolveThreadWorkspaceCwd` (checkpointing/Utils.ts:21-27) returns `worktreePath` FIRST and only falls back to the project root, so on any worktree-backed thread the agent writes into the worktree while the supervisor stats the project root — three fa |

# Loop Watch — `apps/server/src/coil/loop/`

A second fork-owned reactor, shaped exactly like `apps/server/src/coil/autoResume/`, that nudges an
explicitly-armed thread back to life after N minutes of **true silence**, shows the user its budget the
whole time, stops on a file the agent writes, and can never exceed a hard cap. Nothing named
"automation". No new command literal in `packages/contracts`. Three lines of upstream edit, total added
risk **6**.

---

## 1. The trigger — one column, verified

```
idleMs   = now - max(Date.parse(shell.updatedAt), processStartedAtMs)
threshold = busyTurn ? config.busyIdleMs : config.idleMs
fire when idleMs >= threshold
```

`busyTurn` = `shell.session?.status ∈ {running, starting} || shell.latestTurn?.state === "running"`.
Defaults: `idleMs` 15 min (`T3X_LOOP_IDLE_MS`), `busyIdleMs` 45 min (`T3X_LOOP_BUSY_IDLE_MS`), `pollMs`
60 s. Both are overridable **per thread** (a repo whose test suite runs 40 minutes needs a different
fuse from a docs thread) — the override lives beside `overridePrompt` in the same store record.

Why this and nothing else: I re-verified that `thread.activity-appended` is grouped with
`thread.message-sent` in `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:794-808` and
rewrites the row with `updatedAt: event.occurredAt`, and `apps/server/src/orchestration/projector.ts:747-750`
does the same. Background subagent `task.*` events become activity appends. So the predicate stayed
quiet through all 1,358 activities of thread 3a85bdd3 and would have fired at ~01:07 (or 01:37 on the
busy path) instead of the human typing at 04:23. It reads a **SQL projection column, not a hot stream**,
so it is the only trigger in the field that survives a server restart mid-loop.

`processStartedAtMs` is the boot-grace floor and it is not optional: this user's own desktop autobuild
watcher relaunches the app every 12 h, and without the floor every armed thread nudges simultaneously on
the first tick after every relaunch. Same clamp covers laptop sleep.

**Never gate on `session.status`.** A background subagent's assistant message auto-opens a synthetic turn
that pins `session.status = "running"` (`ClaudeAdapter.ts:2469-2489`) and nothing closes it. Reusing
`autoResume/guards.ts:107-111 threadIsProgressing` as a veto would deadlock permanently on exactly the
issue-38 threads. Here `running` only _lengthens_ the fuse. And the nudge is safe on those threads:
`ClaudeAdapter.ts:3730-3737` reads
`const steeringTurnState = context.turnState && context.turnState.synthetic !== true ? ... : null;
if (context.turnState && steeringTurnState === null) { yield* completeTurn(context, "completed"); }`
— a stale synthetic turn is auto-closed and a **real new turn** opens. Steer-absorption only happens on a
genuinely live real turn, which is what the 45-minute busy fuse is for.

Reads per armed thread per tick: `snapshotQuery.getThreadShellById(threadId)` (verified at
`ProjectionSnapshotQuery.ts:2028`; the read `webPush/Reactor.ts:81` already uses) and
`getProjectShellById(shell.projectId)` (`:1922`) for `workspaceRoot`. **Never `getSnapshot()`** — note
`autoResume/Reactor.ts:155,182` still calls it, so this feature is strictly better than the thing it
copies. Zero SQL when nothing is armed.

---

## 2. Firing

Byte-for-byte `autoResume/Reactor.ts:100-123`:

```ts
engine.dispatch({
  type: "thread.turn.start",
  commandId: CommandId.make(`t3x-loop:${uuid}`),
  threadId,
  message: { messageId: MessageId.make(`t3x-loop:${uuid}`), role: "user", text, attachments: [] },
  runtimeMode: shell.runtimeMode,
  interactionMode: shell.interactionMode,
  createdAt,
});
```

**Reserve before dispatch.** `store.recordNudge(threadId, { firedAtMs, createdAtIso })` is persisted
atomically _before_ `engine.dispatch`, copying the comment at `autoResume/Reactor.ts:227-231`
("Reserve the attempt ... BEFORE dispatch so a dispatch failure cannot tight-loop retry"). This is the
only unbounded path in the whole design and it closes it: a provider that cannot spawn burns budget, not
480 attempts a night.

**Keep-active pin repair.** `decider.ts:820-844` — I read it — clears `settledOverride` for _any_
non-null value and `snoozedUntil` unconditionally, with no opt-out. So when the pre-dispatch shell showed
`settledOverride === "active"`, immediately follow the turn start with
`engine.dispatch({type:"thread.unsettle", commandId: CommandId.make(\`t3x-loop-pin:${uuid}\`), threadId, reason:"user"})`.
Verified legal and correct: `ThreadUnsettleCommand.reason`is`Schema.Literal("user")`
(`contracts/orchestration.ts:594-601`) and both projectors map
`settledOverride: reason === "user" ? "active" : null` (`projector.ts:366`,
`ProjectionPipeline.ts:681`). Issued **only** when the pin was already there, so it can never create one.
If the repair dispatch fails, log **and** append an error-tone breadcrumb — never silent.

Snooze is handled by _not dispatching_ (guard below), because `decider.ts:844-858` gives no opt-out.

---

## 3. The nudge text — written out, because it is the feature

Resolution order mirrors `resolveResumePrompt`: per-thread override → `<cwd>/.t3x/loop-prompt.md` →
built-in. `<cwd>` is `worktreePath ?? workspaceRoot` (see §4). Built-in, restated **in full on every
nudge** because a long overnight run will compact away anything taught only once:

```
[t3x loop watch — automated check-in 2 of 6]

This thread has produced no activity for 47 minutes. If you are still working, ignore this
message and carry on.

Otherwise: do NOT restart from the top and do NOT redo finished work. First re-read your own
progress notes for this repo (e.g. .loop/state.json, logs/, GOALS.md, iter-NNN.md — whatever
this repo uses), then continue from the next unfinished item.

When the work is finished, or when you are blocked and need a human, write this exact file:

  /Users/you/repo/.t3x/loop-done

with one line saying why you stopped. That file is the only way to end this loop early.
Otherwise it ends after 6 check-ins, or at 07:00, whichever comes first.

I am the scheduler for this thread. Do not schedule your own wake-ups.
```

The path is **interpolated absolute**, which is the difference between the sentinel working and the run
always ending on budget. The last line resolves the real collision with the user's own
`autonomous-build-loop` skill (two schedulers) in one sentence. The text never begins with `/`.

---

## 4. Stop conditions

Terminal states are **sticky** and only a human re-arm clears them. Each writes a `t3x.loop.stopped`
breadcrumb.

1. **`done` — the sentinel (primary, CLI-native).** `sentinel.ts` stats `<root>/.t3x/loop-done` for
   `root ∈ [shell.worktreePath, project.workspaceRoot]`, **worktree first**, newest mtime wins, honoured
   only when `mtime > record.armedAtMs`. Worktree-first is not cosmetic: `resolveThreadWorkspaceCwd`
   (`apps/server/src/checkpointing/Utils.ts:12-27`) returns `worktreePath ?? workspaceRoot` and that is
   the agent's actual cwd, while `autoResume/Reactor.ts:234` has the precedence _inverted_ — copying it
   would silently break the stop signal on every worktree thread. The supervisor is **read-only**: it
   never writes to the user's filesystem, which is what makes it safe to point at any repo. Any stat
   error ⇒ "no sentinel". `touch .t3x/loop-done` stops a run from a terminal; `rm` keeps it going.
2. **`spent` — budget.** `nudgeCount >= config.maxNudges` (default 6, `T3X_LOOP_MAX_NUDGES`) **or**
   `now >= record.deadlineAtMs` when a deadline is set. Per-arm, not a rolling window. Zinc, and
   **never** rendered as success.
3. **`stalled` — strikes.** At each fire we store `lastNudge.firedAtMs`. At the next decision,
   `workedMs = Date.parse(shell.updatedAt) - lastNudge.firedAtMs`; `workedMs < config.productiveMs`
   (2 min) is a strike, otherwise strikes reset. `strikes >= 2` stops. Two dead nudges is the ceiling on
   a thread that will never move again. Honest limit: a nudge absorbed as a steer into a live real turn
   keeps bumping `updatedAt`, so strikes catch the _dead_ failure, not the _derailed_ one — the busy
   fuse is what bounds that.
4. **`handed-back` — human takeover DISARMS.** `shell.latestUserMessageAt > record.lastNudge.createdAtIso`
   (exact string compare against the `createdAt` we minted; `latestUserMessageAt` is
   `max(createdAt)` over user messages, `ProjectionPipeline.ts:564-570`). This is a **stand-down, not a
   budget reset** — waking at 4 am, reading output and thinking for 20 minutes must not get you nudged
   mid-thought, and deliberately stopping a thread must not hand the loop a fresh six. The pill shows
   `Loop off — you took over` with one-tap re-arm.

**Non-consuming skips** (stay armed, spend nothing, surface the reason in the pill): global toggle off;
`snoozedUntil` in the future; `settledOverride === "settled"`; `hasPendingApprovals`;
`hasPendingUserInput`; `hasActionableProposedPlan`; auto-resume pending; rate-limit suppression live;
min-spacing floor. **Silent disarm**: shell returns `None` (deleted — `getThreadShellById` goes through
`getActiveThreadRowById`) or `archivedAt !== null` or not a Claude thread.

---

## 5. Guards, in order

| #   | Guard                                                                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `config.enabled` (`T3X_LOOP_ENABLED`, default true) — checked once at layer construction; false ⇒ no fiber forks | ops kill switch                                                                                                                                                                                                                                                                                                                                                            |
| 2   | `store.global.enabled` — re-read **every tick and again immediately before dispatch**                            | beta toggle is a true kill switch, not one-tick-stale                                                                                                                                                                                                                                                                                                                      |
| 3   | `record.armed === true` (default **false**)                                                                      | nothing supervised implicitly                                                                                                                                                                                                                                                                                                                                              |
| 4   | shell is `Some`, `archivedAt === null`, `isClaudeThreadShell(shell)`                                             | disarm                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | `settledOverride !== "settled"`                                                                                  | skip, keep budget                                                                                                                                                                                                                                                                                                                                                          |
| 6   | `snoozedUntil == null \|\| parse(snoozedUntil) <= now`                                                           | skip, keep budget — the only way to honour a snooze                                                                                                                                                                                                                                                                                                                        |
| 7   | `settledOverride === "active"` ⇒ nudge **then** repair the pin                                                   | pin survives                                                                                                                                                                                                                                                                                                                                                               |
| 8   | `!hasPendingApprovals && !hasPendingUserInput && !hasActionableProposedPlan`                                     | skip. All three are real SQL-backed columns on `OrchestrationThreadShell` (verified: `contracts/orchestration.ts:432-436`). The plan clause is the one every design but this synthesis missed — `Sidebar.logic.ts:613-621` treats plan-ready as _not_ pending-input, so a thread parked on an unapproved plan otherwise sails through and gets pushed past the human's yes |
| 9   | `autoResumeStore.getThread(threadId).pending === null`                                                           | never nudge a thread with a scheduled resume                                                                                                                                                                                                                                                                                                                               |
| 10  | `now >= record.rateLimitedUntilMs`                                                                               | see §6                                                                                                                                                                                                                                                                                                                                                                     |
| 11  | `now - record.lastNudge.firedAtMs >= config.idleMs`                                                              | redundant-by-design floor; if `updatedAt` ever fails to bump, a tight loop is still structurally impossible                                                                                                                                                                                                                                                                |
| 12  | idle threshold met, computed on a shell **re-read immediately before the guard block and the dispatch**          | freshness discipline from `autoResume/Reactor.ts:179-183`                                                                                                                                                                                                                                                                                                                  |
| 13  | `nudgeCount < maxNudges`, `now < deadlineAtMs`, `strikes < maxStrikes`, sentinel absent                          | the four stops                                                                                                                                                                                                                                                                                                                                                             |
| 14  | armed threads `< config.maxArmedThreads` (default 3) — enforced in the HTTP route **and re-checked in the tick** | ceiling of 3 × 6 = 18 turns per arm cycle, not bypassable by a hand-edited state file                                                                                                                                                                                                                                                                                      |

`session.status` appears **nowhere** in this table. That is the single most important line in the design.

---

## 6. Not fighting auto-resume — both directions

The one-way guard (#9) is not enough, and I verified why. `cancelReason` returns `user-took-over` when
`newestUserMessageId` changes (`autoResume/guards.ts:130-131`) and `fireOne` responds by clearing the
pending resume — so a loop nudge landing between a rate limit and its scheduled resume **destroys**
rate-limit recovery. Guard #9 prevents that. But `autoResume`'s scheduler only arms when
`record.enabled` is true, so on a thread where the user turned auto-resume _off_, a rate limit produces
no pending, guard #9 passes, and the loop nudges straight into a live 5-hour limit.

So the loop runs a **second scoped fiber** that taps `providerService.streamEvents` for
`account.rate-limits.updated`, reuses the fork-owned `classifyRateLimit`
(`apps/server/src/coil/autoResume/classifyRateLimit.ts:56` — imported, not re-mirrored), and on a rejected
verdict writes `record.rateLimitedUntilMs = verdict.resetAtMs` to the **durable** store. Durable, not
in-memory, so it survives the restart that would otherwise reopen the hole. `providerService.streamEvents`
is PubSub-backed, so a second subscriber does not steal auto-resume's events. Belt and braces: a nudge
that is rejected by a limit produces no `updatedAt` movement, so it takes a strike and the thread stops
after two.

> **Update 2026-08-11 (#39).** The `user-took-over` branch quoted above is **gone** — a newer user
> message no longer cancels a pending resume, because the same "keep going" message that tripped it is
> typically the user stepping away, and it was destroying ~24% of armed resumes. So a loop nudge landing
> mid-wait no longer destroys rate-limit recovery. **Guard #9 still stands**, for the other reason:
> nudging a thread that is sitting inside a usage-limit window is pointless work. What changes is that
> #9 is now a politeness rule rather than the only thing standing between a nudge and a stranded thread.
> The rest of §6 — the second fiber, `rateLimitedUntilMs`, the strike interlock — is unaffected.

---

## 7. Budget visibility & settings

**Global, server-side, in Settings** — the user's explicit ask.

Mount: **`apps/web/src/components/settings/BetaSettingsPanel.tsx`** (churn **3**), +2 lines: one import
and `<CoilBetaSettings />` as a sibling section _inside_ the existing `<SettingsPageContainer>`, after
`</SettingsSection>`. Risk **6**.

This deliberately rejects the cheaper-looking `settings.beta.tsx` (churn 1) mount that three of the four
designs chose, because I read both files and it renders a broken page: `BetaSettingsPanel` already returns
a `<SettingsPageContainer>` and that container is `flex-1 overflow-y-auto` (`settingsLayout.tsx:214`), so
`<><BetaSettingsPanel/><LoopSection/></>` puts two flex-1 scroll panes side by side under the settings
Outlet — two scrollbars, both panels squeezed. Mounting inside the panel body also lands the fork rows
inside `SettingsSearchTargetProvider` and inherits the `max-w-4xl` centering and `gap-12`. Risk 6 for a
page that works beats risk 3 for one that does not. `SettingsPanels.tsx` (churn 18, existing fork risk 1044) is not considered.

`<CoilBetaSettings />` is a fork-owned **aggregator**, not a feature component — the same discipline
`apps/server/src/coil/index.ts` documents. The next fork settings feature hangs off it and never re-edits
the row.

Rows (all backed by the fork's own `t3x-loop.json` behind `GET/POST /api/coil/loop`, **never**
`packages/contracts/src/settings.ts` — churn 18, a persisted schema, and the issue-#29 anchor; also it
physically cannot work, since `ServerSettings` decoding drops unknown keys and re-encodes from the decoded
value):

- **"Loop watch (beta)"** — `Switch`, default **off**. Master gate; re-read every tick and pre-dispatch.
- **"Check in after"** — minutes, default 15. **"…if a turn looks busy"** — minutes, default 45.
- **"Check-in budget"** — default 6, max 20 (hard ceiling in the route).
- **"Stop by"** — `<Input type="time">` defaulting to 07:00 plus a "no deadline" toggle. **The browser**
  converts wall-clock to the next occurrence in the user's timezone and POSTs absolute epoch ms; the
  server owns no timezone logic. Grafted straight from RUNWAY — it is the "stop at 7am" the user actually
  wants and it is the cheapest place in the stack to compute it.
- **"Threads armed"** — read-only roster with each thread's state and stop reason, so "did any of my runs
  give up overnight" is answerable from one page without opening three threads.

Numeric inputs copy `BetaSettingsPanel`'s local-draft `AutoSettleDaysInput` pattern (commit on valid
integer, snap back on blur). `searchableSetting()` is skipped — its id union is closed — and that is
noted under the ledger table, since it makes this the fork's _second_ search-invisible row.

**Per-thread arming is not in Settings.** Arming is a per-run decision made at the moment you walk away
from a thread.

---

## 8. UI

- **`ThreadCoilOverlay`** (`apps/web/src/coil/ThreadCoilOverlay.tsx`, fork-owned). The thread route's two
  fork lines — the import at `_chat.$environmentId.$threadId.tsx:18` and
  `<AutoResumeOverlay threadRef={threadRef} />` at `:92` — are **rewritten in place**, not added to. I
  verified the row is exactly `+10 / -6` today, so this is a genuine **delta-0** change: risk stays 80,
  and every future per-thread fork surface is free forever. Every conflict steward in the panel named
  this the best structural idea in the field.
- **`LoopPill`** — collapsed: a dot plus one of `Loop off` · `Loop watching · 12m` · `Loop paused —
snoozed` / `needs you` / `plan ready` / `rate-limited` · `Loop 2/6 · ends 07:00` · `Loop done` ·
  `Loop spent 6/6` · `Loop stalled` · `Loop off — you took over`. The budget is on the face of the pill,
  which is the hard requirement. Colours reuse `Sidebar.logic.ts`'s language: sky/pulse working, amber
  needs-approval, indigo needs-input, violet plan, emerald `done`, **zinc `spent`**, rose `stalled`.
  Grafted from Night Watch and it is the graft I care most about: **`spent` must never be dressed up as
  `done`**, because "it finished" and "it ran out of rope" are the two things the user could not tell
  apart on the night, and every unadopted-sentinel run ends `spent`.
  Expanded: arm `Switch`, per-thread idle/busy threshold overrides, per-thread nudge override `Textarea`,
  the resolved absolute sentinel path with a live tick/cross, budget bars, deadline, and the stop reason.
  Mechanics copied verbatim from `AutoResumeOverlay.tsx`: `ManagedRuntime.make(primaryEnvironmentHttpLayer)`,
  `resolvePrimaryEnvironmentHttpUrl`, hand-rolled `isJsonObject` parsers, 30 s poll + `window` focus,
  optimistic write with an in-flight counter, 600 ms debounce with flush-on-thread-change, and **every
  failure collapsing to `null` so the pill disappears** rather than degrading chat.
- **Timeline breadcrumbs — every re-prompt leaves one.** `engine.dispatch({type:"thread.activity.append", …})`
  with fork-namespaced kinds: `t3x.loop.armed` (info), `t3x.loop.nudged` (info,
  `"Loop check-in 2 of 6 after 47 min of silence."`), `t3x.loop.skipped` (info, edge-detected once per
  reason, so a paused loop is explained rather than mysterious), `t3x.loop.stopped` (info for
  `done`/`handed-back`, **error** for `spent`/`stalled`). `kind` is an open `TrimmedNonEmptyString` and
  `payload` is `Schema.Unknown` (`contracts/orchestration.ts:315-325`), so this is zero contract surface
  and renders in the existing timeline for free. Activity commands use the distinct id prefix
  `t3x-loop-activity:`. Breadcrumbs are edge-detected, never per-tick, so the reactor cannot reset its
  own idle clock.
- **No sidebar section.** `AppSidebarLayout.tsx:203` is churn 15 and a new row; `SidebarV2.tsx` is 33 and
  `Sidebar.tsx` 32. The sidebar is also precisely where upstream #3164's automations UI will land. And no
  DOM-string portal into `[data-app-sidebar] [data-slot="sidebar-content"]` — that launders churn-15 and
  churn-7 dependencies into a place the ledger cannot see, and on mobile `<Sidebar>` renders through a
  base-ui `Sheet` whose popup is absent while closed, so the rail would silently not exist on the one
  surface this user reads at 4 am.

---

## 9. Restart safety

State is a durable JSON file (`t3x-loop.json` in `ServerConfig.stateDir`, `SynchronizedRef` +
`writeFileStringAtomically`, `Object.hasOwn` record lookup, **every field `Schema.withDecodingDefaultKey`**
— all copied from `autoResume/state.ts` for the reasons its comments give: a missing required key fails
the whole-file decode and the boot path turns that into `EMPTY_STATE`, silently disarming everything).
The trigger reads a SQL column. So a reboot at 3 am loses nothing: armed threads stay armed, budgets,
deadlines, strikes, `armedAtMs` and `rateLimitedUntilMs` all survive, and `processStartedAtMs` stops the
first post-boot tick from firing everything at once. This is the property no event-edge design in the
field has, because both `providerService.streamEvents` and `engine.streamDomainEvents` are hot-only.

---

## 10. Registration and seam cost

`apps/server/src/coil/index.ts` (fork-owned, churn **0**, re-measured): a `LOOP_STATE_FILENAME`, a
module-scope `LoopStoreLive`, `LoopReactorLive.pipe(Layer.provide(Layer.mergeAll(LoopStoreLive, AutoResumeStoreLive)))`
into `CoilLayerLive`, and `loopRouteLayer.pipe(Layer.provide(LoopStoreLive))` into `CoilRoutesLive` — the
module-scope-store-identity pattern that file's own docstring explains and `autoResume/sharing.test.ts`
pins. `apps/server/src/server.ts` (churn 29) does not move. No contracts edit, no migration, no `ws.ts`,
no `ClaudeAdapter.ts`, no `options.hooks`, no new route file (so `routeTree.gen.ts` never regenerates).

**Total new upstream risk: 6.** One new ledger row, two lines, in a churn-3 file.

Two fork-owned corrections ride along, both free and both required for correctness:
`isClaudeThread` is widened from `(thread: OrchestrationThread)` to `Pick<OrchestrationThread, "session">`
so a `Shell` is assignable (verified: it is not today, so three of the four designs' "reuse, don't mirror"
claim would not typecheck); and `authenticateWithOperateScope` moves to a shared
`apps/server/src/coil/http/auth.ts` rather than becoming a **third** paste
(`autoResume/http.ts:45` + `webPush/http.ts:49` already duplicate it, and only one is in the ledger).

---

## 11. Claude Code CLI compatibility

The nudge is an ordinary user turn through the existing streaming-input SDK session — `role: "user"`,
same path a keystroke produces, respawn and `--resume` already handled by `ClaudeAdapter`. Because
`systemPrompt: {type:"preset", preset:"claude_code"}` and `settingSources: ["user","project","local"]`
are set, the user's `~/.claude` and `.claude/` hooks, skills and slash commands apply to a Loop Watch turn
exactly as to a terminal one. The stop signal is a file written with `Write`. The nudge text is
user-replaceable via a committable `<cwd>/.t3x/loop-prompt.md`. Zero SDK-version coupling: nothing touches
`SDKResultSuccess`, `total_cost_usd`, `StopHookInput.background_tasks`, `session_crons`, `task_updated`,
or `raw.method`. An SDK bump cannot break it.

---

## 12. What this honestly does not solve

- **A single silent tool call longer than 45 minutes reads as idle**, and the nudge is then absorbed as a
  steer into the live turn with no visible turn boundary. `busyIdleMs` is a magic number, tunable per
  install and per thread, not a solution.
- **Without the sentinel, `done` is unreachable and every run ends `spent`.** That is why the absolute
  path is interpolated and the contract restated every nudge, why `spent` is visually distinct, and why
  the first check-in is always partly a briefing cost.
- **Cost is not metered.** The budget is turns and wall-clock, not dollars — deliberately, because
  `total_cost_usd` is a field nothing in this repo has ever read and its per-turn-vs-per-session semantics
  are unverified. A ledger whose selling point is trust must not be built on an unverified number.

## Ideas grafted from losing designs

- From RUNWAY: a MANDATORY budget with no unlimited mode, enforced with a 400 at the POST route. A supervisor you can leave running overnight has to answer 'when does this stop and what will it have cost' before you go to sleep. Deadman's 6-nudge cap was already there; RUNWAY's insight is that it must be non-optional and non-bypassable.
- From RUNWAY: the wall-clock DEADLINE, entered as `<Input type="time">` (default 07:00) and converted BY THE BROWSER to absolute epoch ms. The server owns no timezone logic, and 'stop at 7am' is what the user actually means. Checked in the tick, not on an event edge, so a run that goes dark at 03:00 still gets stopped at 07:00.
- From RUNWAY: RESTATE THE STOP PROTOCOL VERBATIM IN EVERY NUDGE, not just the first. A 6-check-in overnight run will compact, and a contract taught only once is gone by check-in 4. This is a one-line change that decides whether the sentinel ever gets written.
- From RUNWAY: the reserve-before-dispatch discipline made explicit as a spec requirement rather than an implied copy. `autoResume/Reactor.ts:227-231` already documents it; Deadman left the ordering unstated, which is the one path where blast radius was unbounded.
- From Night Watch: the HONEST TERMINAL VOCABULARY — `done` (emerald, sentinel) vs `spent` (zinc, budget/deadline) vs `stalled` (rose, strikes) vs `handed-back` (slate). `spent` must NEVER be dressed up as `done`. Telling 'it finished' from 'it ran out of rope' from 'it died' is literally the thing the user could not do on the night, and since an unadopted sentinel makes `spent` the common case, this distinction is load-bearing rather than cosmetic.
- From Night Watch: SURFACE THE REFUSALS. A skip on snooze / settled / needs-approval / plan-ready / rate-limited is rendered as `Loop paused — snoozed` in the pill and edge-detected as one `t3x.loop.skipped` breadcrumb, instead of the feature silently never firing. Correct behaviour that reads as a bug is a bug.
- From Night Watch: Web Push on terminal transitions, reusing the fork-owned `webPush/send.ts` + `PushSubscriptionStore` through the module-scope `WebPushDepsLive` value, at zero seam and zero `sw.js` change. Phased to 2 with an honest caveat (see openRisks) rather than claimed as solved.
- From BATON: the explicit scheduler-ownership line in the prompt — 'I am the scheduler for this thread. Do not schedule your own wake-ups.' This resolves the one real collision with the user's own `autonomous-build-loop` skill, which otherwise has the agent calling ScheduleWakeup against a server that is already scheduling it.
- From BATON: park reasons are STICKY and human-cleared. No automatic un-park, because every stop reason is either success or a condition that recurs immediately.
- From BATON (learned by its failure, not its success): all file freshness is `fs.stat().mtimeMs`, never a timestamp the model types into a file. BATON gated DONE on a model-authored `contract.updatedAt`; models do not know the wall clock, so `done` was unreachable whenever it guessed wrong. Deadman already used mtime — this makes it an explicit, non-negotiable rule.
- From the Night Watch and BATON reviews, not their designs: `worktreePath` FIRST, then `workspaceRoot`, for every filesystem read. Verified at `apps/server/src/checkpointing/Utils.ts:12-27` — that is the agent's real cwd, and `autoResume/Reactor.ts:234` has the precedence inverted, so copying the existing fork code would have silently broken the stop signal on every worktree-backed thread.
- From the BATON conflict review: `!shell.hasActionableProposedPlan` as a guard. Verified as a real column at `contracts/orchestration.ts:436`, and `Sidebar.logic.ts:613-621` treats plan-ready as NOT pending-input — so a thread parked on an unapproved plan otherwise passes every other blocking guard and gets pushed past the human's yes. No design in the field had it.

## Ideas deliberately rejected

- RUNWAY's turn-boundary arming (its entire headline mechanism). VERIFIED FATAL, twice over: `stopSessionInternal` calls `completeTurn(context, "interrupted", "Session stopped.")` at `ClaudeAdapter.ts:3057`, so a real-turnId `turn.completed` is emitted when the user hits Stop — arming on it restarts exactly the work they just killed. And the `if (!turnState)` branch at `ClaudeAdapter.ts:1957-1982` emits `turn.completed` with NO `turnId` while still carrying `totalCostUsd`, so any turnId-keyed denylist arms falsely and charges phantom cost. The denylist is also hot-stream-only and therefore EMPTY after every restart, meaning it fails open.
- The `raw.method === "claude/synthetic-turn-start"` discriminator as a load-bearing dependency. It is real on the wire (`ClaudeAdapter.ts:2504`, versus the real path at `:3793-3801` emitting `providerRefs: {}` and no `raw`), and it is a genuinely clever find — but `RuntimeEventRaw.method` is a free `Schema.optional(TrimmedNonEmptyString)` with no literal union and no upstream test, in a churn-12, ~3950-line hot file. A rename produces no conflict, no type error, and no failing test; the loop just starts charging phantom turns. A fork test asserting a fork-defined constant cannot detect upstream drift. Not needed, because this design never gates on `session.status` at all.
- BATON's agent-authored JSON contract (`.t3x/loop/<threadId>.json` with status/iteration/remaining/evidence). It outsources the hardest judgement to the thing that just failed — the issue-38 agent marked a turn `completed` with 33 minutes of work left — and it degrades silently: an agent that does not honour the schema parks after three turns and goes quiet, which from the user's chair is indistinguishable from the bug. A one-line sentinel with an mtime gate gets the same CLI-compatibility for a fraction of the protocol surface.
- Night Watch's `.loop/state.json` done-marker. VERIFIED FICTION. The user's own template at `~/.claude/skills/auto-loop-bootstrap/assets/templates/.loop/state.json` is `{stage, iter, pr_mode, pr_size_policy, base_branch, backlog_source}` — no `status`, no `remaining`, no `backlog` — and the companion `CLAUDE.md:50` says `The loop NEVER halts on a semantic event`. The rule matches nothing the target user's agent ever writes. (`iter` is kept as an optional Phase-3 progress hint.)
- Night Watch's `progressFingerprint = turnId + assistantMessageId + checkpoint count`. Uncomputable from the claimed single read: `OrchestrationLatestTurn` (`contracts/orchestration.ts:335-343`) has no checkpoint count. And the surviving two fields change on every nudge that opens a real turn, so the named anti-token-burn kill switch would have been inert. Replaced by the strike detector on `updatedAt` movement.
- Blocking nudges on `phase === "failed"`. A `thread.turn.start` is precisely what makes `ClaudeAdapter` respawn the provider with `--resume` — auto-resume relies on that in production. `latestTurn.state === "error"` is sticky until a new turn opens, so this guard would permanently disable recovery on the single likeliest cause of total silence.
- The sidebar Watch Rail and its `document.querySelector('[data-app-sidebar] [data-slot="sidebar-content"]')` portal. It launders a churn-15 (`AppSidebarLayout.tsx:190`) and churn-7 (`ui/sidebar.tsx:704`) dependency into a runtime string the ledger cannot see, and bills it at zero — the exact optimization SEAMS.md exists to forbid. It also does not work where it matters: on mobile `<Sidebar>` renders through a base-ui `Sheet` whose popup is absent while closed, so the rail would be silently missing on the phone this user reads at 4 am, and the proposed desktop contract test would pass green over it.
- Mounting the fork settings section in `apps/web/src/routes/settings.beta.tsx` (churn 1). Three of the four designs chose it as 'the cheapest mount in the tree'. It renders a broken page: `BetaSettingsPanel` already returns a `<SettingsPageContainer>` and that container is `flex-1 overflow-y-auto` (`settingsLayout.tsx:214`), so two of them as siblings produce two scroll panes. Risk 6 in `BetaSettingsPanel.tsx` for a page that works beats risk 3 for one that does not.
- Human takeover as a BUDGET RESET (BATON stop rule 10, Deadman's reset semantics). Wrong default in both directions: reading output for 20 minutes gets you nudged mid-thought, and deliberately stopping a thread hands the loop a fresh six nudges. Takeover DISARMS.
- Cost/USD metering as a stop condition. `total_cost_usd` flows from `SDKResultSuccess` and nothing in this repo has ever read it; the SDK's own only documented use of that field name describes it as accumulated by the SESSION, so summing it per turn would inflate quadratically and a '$25 cap' would trip around iteration 6 of a $4 run. A ledger whose selling point is trust cannot rest on an unverified number. Budget is turns + wall clock.
- `searchableSetting()` registration. Its id union is closed to the upstream catalog, so registering means editing `settingsSearch.ts` (created 2026-07-31 — 'churn 1' is a two-day measurement artifact, not a stability signal) and its single append-ordered `SETTINGS_SEARCH_ITEMS` array, which is structurally the same add/add conflict shape as issue #29. Skipped, and noted under the ledger table as the fork's second search-invisible row.
- Auto-arming any thread with an active turn. It would have saved the same night with zero clicks and it is exactly how a token-burn incident happens. Two switches stay.
- `options.hooks` / `Stop` / `SubagentStop` / the `background_tasks` roster. Strictly better drain signals, but `ClaudeAdapter` sets no hooks anywhere, making it a fresh edit to a churn-12 hot file. Deferred to Phase 3 and gated on a real NDJSON capture proving `updatedAt` is too coarse.
- A `thread.wake-if-idle` command literal in `packages/contracts/src/orchestration.ts`. That is upstream #5123's pre-announced landing zone (the `ThreadSnoozeCommand` comment) in a churn-12 file. Zero contracts edits means this feature becomes a _caller_ when it lands, with no migration.

## Implementation plan

### Phase 1 — the loop that fixes the night (shippable alone; closes radroid/t3code#38)

Fork-owned prep, zero behaviour change: move `authenticateWithOperateScope` into a shared `apps/server/src/coil/http/auth.ts` and re-point `autoResume/http.ts` + `webPush/http.ts` at it (today there are two independent pastes and only one is in the ledger); widen `isClaudeThread` to `Pick<OrchestrationThread, "session">` so an `OrchestrationThreadShell` is assignable.

Server feature. `config.ts` — pure `resolveConfig(env)` over `T3X_LOOP_{ENABLED,POLL_MS,IDLE_MS,BUSY_IDLE_MS,MAX_NUDGES,MAX_STRIKES,PRODUCTIVE_MS,MAX_ARMED}`, plus `resolveNudgePrompt({cwd, threadOverride})` with the override → `<cwd>/.t3x/loop-prompt.md` → built-in ladder, interpolating the ABSOLUTE sentinel path, the check-in index, the idle duration, and the deadline into the text. `state.ts` — durable `t3x-loop.json` in `ServerConfig.stateDir`, `SynchronizedRef` + `writeFileStringAtomically`, `Object.hasOwn` lookup, every field `Schema.withDecodingDefaultKey`; global `{enabled, defaults}` plus per-thread `{armed, armedAtMs, deadlineAtMs, nudgeCount, strikes, lastNudge:{firedAtMs,createdAtIso}|null, stoppedReason, overridePrompt, idleMsOverride, busyIdleMsOverride, rateLimitedUntilMs}`. `guards.ts` — shell-typed pure predicates (`idleThresholdMsFor`, `idleMs`, `isClaudeThreadShell`, `threadIsGoneShell` on archivedAt/settledOverride only, `blockedOnHuman` incl. `hasActionableProposedPlan`, `humanTookOver`, `strikeAfter`); imports `isClaudeThread` and `classifyRateLimit` from `autoResume/` rather than re-mirroring. `sentinel.ts` — stats `.t3x/loop-done` under `worktreePath` then `workspaceRoot`, newest mtime wins, honoured only when `mtime > armedAtMs`, every error → null, read-only. `decide.ts` — one pure `decideLoopAction(input) => {kind:"skip"|"nudge"|"stop", reason, nextRecord}` holding every guard in table order; no Effect, no IO. `Reactor.ts` — `Layer.effectDiscard(makeSupervisor)` with TWO `Effect.forkScoped` fibers: the poll tick (`processTick.pipe(catchCause(log), delay(pollMs), forever)`) and the rate-limit tap (`Stream.runForEach(providerService.streamEvents, …)` filtering `account.rate-limits.updated`, writing `rateLimitedUntilMs` durably). Tick per armed thread: `getThreadShellById` + `getProjectShellById` + sentinel stat + `decideLoopAction`; on nudge, persist the counter FIRST, then dispatch `thread.turn.start`, then the conditional `thread.unsettle{reason:"user"}` pin repair, then the breadcrumb. `processStartedAtMs` boot floor. `http.ts` — `/api/coil/loop`, GET (`?threadId=`) returns `{globalEnabled, defaults, armed:[{threadId,state,nudgeCount,maxNudges,deadlineAtMs,stoppedReason}], thread:{…}}`, POST accepts partial `{globalEnabled?, defaults?, threadId?, armed?, deadlineAtMs?, overridePrompt?, idleMsOverride?, busyIdleMsOverride?}`, `maxArmedThreads` 409, `maxNudges` clamped to 20; `Layer.unwrap` store-at-construction so the requirement never reaches upstream's `makeRoutesLayer`.

Registration: 4 lines in `apps/server/src/coil/index.ts` (module-scope `LoopStoreLive`, reactor into `CoilLayerLive` with `AutoResumeStoreLive` also provided, route into `CoilRoutesLive`).

Web: `loopClient.ts` (ManagedRuntime + `resolvePrimaryEnvironmentHttpUrl`, hand-rolled parsers, every failure → null); `LoopPill.tsx` (collapsed status + budget on the face; expanded arm switch, thresholds, prompt override, resolved sentinel path with live tick/cross, stop reason); `ThreadCoilOverlay.tsx` (fork-owned aggregator rendering AutoResumeOverlay + LoopPill in one absolutely-positioned column); `CoilBetaSettings.tsx` (fork-owned settings aggregator) + `LoopBetaSection.tsx` (master toggle, thresholds, budget, armed-thread roster with stop reasons).

Upstream edits — exactly three lines across two files: `_chat.$environmentId.$threadId.tsx` lines 18 and 92 rewritten in place `AutoResumeOverlay` → `ThreadCoilOverlay` (delta 0, row unchanged at +10/-6); `BetaSettingsPanel.tsx` +2 lines mounting `<CoilBetaSettings />` inside the existing `SettingsPageContainer` (new row, risk 6).

Tests: `decide.test.ts` (full policy matrix — every guard, every stop reason, strike arithmetic, takeover disarm, settled/snoozed/keep-active/plan-ready branches, rate-limit suppression); `guards.test.ts` (threshold selection incl. the stuck-synthetic case: status running + updatedAt 3h old fires at busyIdleMs; boot-floor clamp); `sentinel.test.ts` (mtime gating, worktree-beats-workspace precedence, missing/error paths); `state.test.ts` (decode defaults, corrupt-vs-unreadable, prototype-key safety); `http.test.ts` (auth/scope, 400s, 409 on maxArmed, clamps, partial POST); `Reactor.test.ts` (end-to-end against stub engine + snapshot query: silence → nudge → sentinel → stop; budget → spent; two dead nudges → stalled; keep-active pin restored; rate-limited thread skipped; auto-resume pending skipped; boot burst suppressed). Plus **`updatedAtContract.test.ts`** — a fork-owned test asserting that dispatching `thread.activity.append` moves `getThreadShellById(...).updatedAt`, which turns the design's one silent logic mirror into a red test.

Docs: `docs/coil/SEAMS.md` gets the new row, two Logic-mirrors rows, one Parallel-paths row, the corrected auth-mirror note, and updated header totals — in the same commit, per SEAMS.md:24-27.

**Files:**

- `apps/server/src/coil/http/auth.ts`
- `apps/server/src/coil/autoResume/http.ts`
- `apps/server/src/coil/autoResume/guards.ts`
- `apps/server/src/coil/webPush/http.ts`
- `apps/server/src/coil/loop/config.ts`
- `apps/server/src/coil/loop/state.ts`
- `apps/server/src/coil/loop/guards.ts`
- `apps/server/src/coil/loop/sentinel.ts`
- `apps/server/src/coil/loop/decide.ts`
- `apps/server/src/coil/loop/Reactor.ts`
- `apps/server/src/coil/loop/http.ts`
- `apps/server/src/coil/loop/decide.test.ts`
- `apps/server/src/coil/loop/guards.test.ts`
- `apps/server/src/coil/loop/sentinel.test.ts`
- `apps/server/src/coil/loop/state.test.ts`
- `apps/server/src/coil/loop/http.test.ts`
- `apps/server/src/coil/loop/Reactor.test.ts`
- `apps/server/src/coil/loop/updatedAtContract.test.ts`
- `apps/server/src/coil/index.ts`
- `apps/web/src/coil/loopClient.ts`
- `apps/web/src/coil/LoopPill.tsx`
- `apps/web/src/coil/ThreadCoilOverlay.tsx`
- `apps/web/src/coil/CoilBetaSettings.tsx`
- `apps/web/src/coil/LoopBetaSection.tsx`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- `apps/web/src/components/settings/BetaSettingsPanel.tsx`
- `docs/coil/SEAMS.md`
- `docs/coil/loop/DESIGN.md`

### Phase 2 — deadline and phone (turns 'it works' into 'I can sleep')

Wall-clock deadline UI: `<Input type="time">` + a 'no deadline' toggle in the beta section and in the per-thread expanded panel; the BROWSER computes the next occurrence in the user's timezone and POSTs absolute epoch ms. Server stores `deadlineAtMs` per thread and checks it in the tick (so a run that goes dark at 03:00 is still stopped at 07:00). The pill face shows `Loop 2/6 · ends 07:00`.

`notify.ts`: Web Push on terminal transitions only (`done`/`spent`/`stalled`/`handed-back`, never per nudge), reusing `webPush/send.ts` + `PushSubscriptionStore` + `WebPushVapid` via the module-scope `WebPushDepsLive` value already in `t3x/index.ts:64`. `AttentionPushPayload`-shaped with `key: \`loop::${env}::${threadId}\`` so it replaces in place. **`apps/web/public/sw.js`needs zero changes** — it already renders generic`title`/`body`/`key`with`renotify`and routes`notificationclick`on`environmentId`/`threadId`. One push per thread per terminal transition, hard-capped by a `pushCooldownMs`.

In-page fallback: because `sw.js:38-42` returns early whenever this device has any T3 window open, add a `NotificationCoordinator`-side handler that raises a real Notification via the existing `showAttentionNotification` path rather than only a toast — otherwise a phone with a backgrounded T3 tab (this user's exact setup over Tailscale) gets nothing at all.

Armed-thread roster on the beta settings page gets stop reasons and elapsed budget, so 'did any of my three runs give up overnight' is one page, not three thread opens.

**Files:**

- `apps/server/src/coil/loop/notify.ts`
- `apps/server/src/coil/loop/notify.test.ts`
- `apps/server/src/coil/loop/Reactor.ts`
- `apps/server/src/coil/loop/state.ts`
- `apps/server/src/coil/loop/http.ts`
- `apps/web/src/coil/LoopPill.tsx`
- `apps/web/src/coil/LoopBetaSection.tsx`
- `apps/web/src/components/NotificationCoordinator.tsx`

### Phase 3 — sharper liveness (each item independently gated on verification)

(a) **Synthetic-turn fast path.** VERIFY FIRST that the projection populates `latestTurn.requestedAt` from a synthetic `turn.started`. If it does, `latestTurn.requestedAt` newer than `latestUserMessageAt` by more than a few seconds is a zero-seam synthetic-turn detector — and a synthetic turn is exactly the case where a nudge is SAFE (`ClaudeAdapter.ts:3730-3737` auto-closes it, so no steer risk). Use `idleMs` instead of `busyIdleMs` there: fires at ~01:07 instead of 01:37 on the issue-38 shape while keeping the 45-minute conservatism where it actually matters. Ships as one clause in `guards.ts` + tests, or is dropped if the projection does not carry it.

(b) **Better progress signal for strikes.** Today a strike is 'less than 2 minutes of `updatedAt` movement'. Optionally read `<cwd>/.loop/state.json`'s `iter` (which the user's own template DOES carry — verified) as a monotonic progress hint, and/or `git rev-parse HEAD` movement in the worktree. Both are incidental to work the agent already does rather than a narrated claim. Read-only, failure → 'no signal', never a stop condition on its own — only a strike-reset input.

(c) **`Stop`/`SubagentStop` hooks and the `background_tasks` roster.** Strictly better drain signals than `updatedAt` alone, but they require `options.hooks` in `ClaudeAdapter.ts` (churn 12, ~3950 lines, no hooks set anywhere today). Gate on a real NDJSON capture via `ClaudeAdapterLiveOptions.nativeEventLogPath` proving `updatedAt` is actually too coarse in practice. Do not build it speculatively.

(d) **Adopt upstream #5123's `thread.wake-if-idle` if it lands.** `decide.ts`'s nudge branch becomes a caller; no migration, because Phase 1 added no command literal.

**Files:**

- `apps/server/src/coil/loop/guards.ts`
- `apps/server/src/coil/loop/guards.test.ts`
- `apps/server/src/coil/loop/progress.ts`
- `apps/server/src/coil/loop/progress.test.ts`
- `apps/server/src/coil/loop/decide.ts`
- `docs/coil/loop/DESIGN.md`

### Phase 4 — ledger paydown (independent; pays the row-35 tripwire)

Collapse the three fork mounts in `apps/web/src/routes/__root.tsx` (`NotificationCoordinator`, `ThreadOutboxDrain`, `PushSubscriptionManager` — imports at 20-22, JSX at 142-144) into one fork-owned `<CoilRoot authenticated={primaryEnvironmentAuthenticated} />` in `apps/web/src/coil/CoilRoot.tsx`. Takes that row from 6 fork lines to 2 in a churn-9 file: **risk 54 → 18, a net −36**, and makes every future headless fork surface seam-free. The web tree then has the same two aggregators the server has had since `t3x/index.ts`.

Be honest in the ledger note: this reduces RISK but does not REMOVE a row, and SEAMS.md's tripwire asks for re-isolation. The only change that genuinely removes a row is moving `notifyOnNeedsInput` out of `packages/contracts/src/settings.ts` (+7/-2, churn 18, **risk 162**, a persisted schema and the issue-#29 anchor) into the fork's own JSON store — which is exactly the argument this design already makes for keeping loop config out of that file. That is a real settings migration with its own review; propose it as an optional follow-up with a data-migration path, do not bundle it.

**Files:**

- `apps/web/src/coil/CoilRoot.tsx`
- `apps/web/src/routes/__root.tsx`
- `docs/coil/SEAMS.md`

## Seam ledger delta

## Main ledger — ONE new row (34 → 35). Header totals move by +2 lines / +6 risk.

| Upstream file                                            | fork Δ  | churn | risk | Why the fork touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------- | ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/settings/BetaSettingsPanel.tsx` | +2 / -0 | 3     | 6    | Mounts the fork's `<CoilBetaSettings />` aggregator as a sibling section **inside** the existing `<SettingsPageContainer>`. The cheaper-looking mount in `apps/web/src/routes/settings.beta.tsx` (churn 1) renders a broken page: `BetaSettingsPanel` already returns a `SettingsPageContainer`, which is `flex-1 overflow-y-auto` (`settingsLayout.tsx:214`), so two as siblings produce two scroll panes. Mounting inside also lands the fork rows in `SettingsSearchTargetProvider` and inherits the `max-w-4xl` centering. **Demolition note:** this file and `settings.beta.tsx` were both created 2026-07-22 (`32c6012da`, sidebar-v2 beta), so churn 1/3 is an 11-day artifact, not stability; when sidebar v2 graduates upstream will likely delete both and drop `/settings/beta` from the closed `SettingsPath` union — a delete/modify conflict. Pre-decided fallback: fold the four globals into the per-thread `LoopPill` panel and drop this row, or own a fork route. |

**Unchanged, explicitly:** `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` stays at **+10 / -6, churn 5, risk 80, delta 0** — lines 18 and 92 are rewritten in place from `AutoResumeOverlay` to the fork-owned `ThreadCoilOverlay` aggregator (same line count, same fork Δ), which permanently caps that row's growth for every future per-thread fork surface. `apps/server/src/server.ts` (3-line seam, churn 29, risk 87) does not move. No row for `packages/contracts/**`, `ClaudeAdapter.ts`, `Migrations.ts`, `ws.ts`, `AppSidebarLayout.tsx`, `SidebarV2.tsx`, `Sidebar.tsx`, `ChatView.tsx`, `settingsSearch.ts`, or `routeTree.gen.ts`.

## Logic mirrors — TWO new rows

| Mirrored upstream logic                                                                                                                                                                                                     | Fork copy                                                                              | upstream churn | Why it is a mirror, and what breaks silently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projection_threads.updated_at` is bumped by `thread.activity-appended` — `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:794-808` (churn 7) and `apps/server/src/orchestration/projector.ts:747-750` (churn 4) | The entire Loop Watch trigger in `apps/server/src/coil/loop/guards.ts`                  | 7 / 4          | This is **incidental bookkeeping, not a contract**. `ProjectionPipeline.ts:805-808` does a full-row upsert plus a `refreshThreadShellSummary` for every single activity — 1,358 of them on thread `3a85bdd3` — which is exactly the kind of write amplification upstream optimizes. If activity appends are ever split off `updated_at`, the loop **inverts**: it goes quiet during real silence and starts firing during heavy subagent streaming, steering a live agent. No conflict, no type error. **Mitigation shipped in the same PR:** `apps/server/src/coil/loop/updatedAtContract.test.ts` asserts that dispatching `thread.activity.append` moves `getThreadShellById(...).updatedAt`, turning silent drift into a red test. |
| `thread.turn.start` clears `settledOverride` for ANY non-null value and clears `snoozedUntil` unconditionally — `apps/server/src/orchestration/decider.ts:820-858` (churn 5)                                                | The keep-active pin repair and the snooze skip in `apps/server/src/coil/loop/decide.ts` | 5              | The fork mirrors private decider behaviour to defend against it. Upstream #5123's `thread.wake-if-idle` is precisely the ticket that would motivate making that reset conditional; if it does, the repair `thread.unsettle{reason:"user"}` fires against a pin upstream no longer clears and silently pins threads the user never pinned. `decide.test.ts` pins the observed behaviour so a change is caught at sync.                                                                                                                                                                                                                                                                                                                 |

**Correction to the existing auth-mirror row:** its note reads "Checked 2026-08-02: `apps/server/src/http.ts` had no upstream commits this range." That is wrong — the file took 12 commits in the window (incl. `97e5cd3bf` "[codex] align server auth Effect services (#3180)"). The row also under-reports the mirror: `authenticateWithOperateScope` exists at `autoResume/http.ts:45` **and** as `authenticateWithScope` at `webPush/http.ts:49`. Phase 1 collapses both into a shared fork-owned `apps/server/src/coil/http/auth.ts` so the loop route does not become a third paste, and the row is rewritten to name one mirror at churn 12.

## Parallel paths — ONE new row

| Fork path                                                                        | Upstream path it bypasses                                                                          | Hazard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/coil/loop/Reactor.ts` dispatching `thread.turn.start` on a timer | The client send path's preconditions (`sendDisabledReason`, plan-approval gating, composer guards) | This is now the **second** fork-owned unattended producer of `thread.turn.start` (auto-resume is the first, and it is not currently in this table — add it). The dispatch does go through upstream's decider, so command-layer preconditions apply automatically; what it bypasses is every _client-side_ gate. It also becomes the only non-user emitter of `thread.unsettle{reason:"user"}`, a reason the contract restricts specifically so "a client cannot forge the neutral reset" (`contracts/orchestration.ts:596-601`). **At every sync, re-check:** (1) has upstream added a shell field expressing "waiting on a human" beyond `hasPendingApprovals` / `hasPendingUserInput` / `hasActionableProposedPlan`? (2) has upstream #3164 landed automations with its own enablement/budget gate that this path silently bypasses? (3) has #5123's `thread.wake-if-idle` landed, in which case `decide.ts`'s nudge branch should become a caller of it. |

## Settings-search note (append under the ledger table)

Loop Watch's beta rows are **not** registered in `apps/web/src/components/settings/settingsSearch.ts`, for the same reason the fork's `notifyOnNeedsInput` row is not: `searchableSetting()`'s id type is closed to the upstream catalog, and `SETTINGS_SEARCH_ITEMS` is a single append-ordered array — structurally the same add/add conflict shape as issue #29 — in a file created 2026-07-31, so its "churn 1" is a two-day measurement artifact rather than a stability signal. This makes Loop Watch the fork's **second** search-invisible settings surface. Nothing enforces registration; no test asserts that every rendered row is in the catalog, so this will stay silent.

## Open risks

- A single silent tool call longer than `busyIdleMs` (45 min default) reads as idle — a full `pnpm test` on this repo needs `--concurrency-limit 2` and a raised hookTimeout, and native builds OOM this 16 GB Mac, so long silent tool time is normal here, not pathological. The nudge is then absorbed as a steer into the live turn (`ClaudeAdapter.ts:3730-3737`) with no visible turn boundary, so the user sees a derailed agent and no obvious cause. Mitigated by the 45-minute default, per-thread overrides, and a nudge text explicitly written to be harmless as an interjection. NOT eliminated — this is the single realest downside of leaning entirely on `updatedAt`, and the strike detector cannot see it (a steered turn keeps bumping `updatedAt`, so strikes reset).
- Without the sentinel, `done` is unreachable and EVERY run ends `spent`. The user's own `autonomous-build-loop` protocol says outright `The loop NEVER halts on a semantic event` (template CLAUDE.md:50), so their agents are conditioned against declaring completion at all. Mitigated by interpolating the absolute path, restating the contract every check-in, worktree-first stat, and making `spent` visually distinct — but 'stopped on budget' is a worse outcome than 'stopped on done' every time, and prompt-dependent contracts rot silently across model versions.
- Phone delivery is not solved by Phase 2 alone. `sw.js:38-42` returns early whenever `clients.matchAll({type:"window", includeUncontrolled:true})` is non-empty on THAT DEVICE — so a phone with a backgrounded, frozen T3 tab (this user reaches t3code from their phone over Tailscale) suppresses push and hands off to an in-page coordinator that is not executing. Note three of the four designs reasoned about this incorrectly, claiming a laptop tab suppresses the phone's push; the client set is per-registration, so the real suppressor is the phone's own tab, which is both more likely and worse. Phase 2's `showAttentionNotification` fallback is a partial answer and needs real on-device testing before it is claimed as working.
- Two fork reactors, one thread, with no in-tree coordination primitive. The `pending !== null` guard plus the durable rate-limit suppression closes both directions I can see, but nothing tests that a THIRD `thread.turn.start` producer under `t3x/` would compose with either, and there is no shared lock. The new Parallel-paths row is the only tripwire.
- The `updatedAt` mirror is the whole trigger and it is incidental upstream bookkeeping (a full-row upsert plus `refreshThreadShellSummary` per activity — precisely the shape upstream optimizes). The shipped contract test catches a semantic change but only if the fork's test infrastructure keeps running it against real projection wiring rather than stubs; a `as never` cast or a stubbed projector would silently defeat it, which has already happened once in this fork's history.
- Upstream #3164 (Automations & Triggers, 🚧 In Progress, landing in apps/web) will ship project-scoped loops with their own enablement and safety gates. When it lands, Loop Watch becomes a parallel path that bypasses all of them with no conflict, no type error and no failing test — the fork's documented worst hazard. Mitigation is that retirement is `rm -r apps/server/src/coil/loop apps/web/src/coil/Loop*` plus reverting three lines, and the ledger row carries an explicit adopt-or-sunset criterion.
- The mount file's churn is a newborn artifact. `BetaSettingsPanel.tsx` and `settings.beta.tsx` were both created 2026-07-22; churn 3 over an 11-day life normalizes to ~16/60d, not 3. `BetaSettingsPanel` contains ONLY sidebar-v2 rows and v2 is already defaulted on for nightly/dev (#4491), so the likely upstream action on graduation is deleting the file — a delete/modify conflict, the class this fork has already been bitten by. The fallback is pre-decided but untested.
- No push to the UI for fork routes. `EnvironmentSubscriptionRpcTag` is a closed union, so the pill polls at 30 s and a nudge that fires at T shows somewhere in T..T+30 s. The timeline breadcrumb is immediate, so this is cosmetic — but the global toggle is read pre-dispatch specifically because a 30 s stale read of the kill switch would not be.
- Worst-case token burn is 3 armed threads × 6 check-ins = 18 extra user turns per arm cycle, each gated behind ≥15 min of silence, two switches, a strike detector and a deadline. Structurally bounded (monotonic durable counter, only a human write resets it) but 18 turns on a 31-turn context is real money if someone arms three threads and forgets. There is no dollar meter, deliberately.
- The synthetic-turn fast path in Phase 3 is unverified: I confirmed the synthetic turn emits `turn.started` with a fresh `requestedAt`, but not that the projection's `latestTurn.requestedAt` is populated from it in a way that reliably beats `latestUserMessageAt`. If it is not, Phase 3(a) is dropped and issue-38-shaped threads keep the 45-minute fuse instead of 15.
