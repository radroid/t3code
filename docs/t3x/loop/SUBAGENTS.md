# How Claude Code subagents actually work on the wire

Captured 2026-08-02 against `claude` 2.1.220 in `--output-format stream-json` mode — the same mode
T3 Code's `ClaudeAdapter` drives through the Agent SDK. Raw captures are in `captures/`.

This exists because issue #38's root cause was described as "a turn reports `completed` while
background subagents are still streaming activities", and the fix depended on guessing at that
mechanism. It no longer does — the mechanism is reproduced below, event for event.

## The foreground lifecycle

`captures/subagent-foreground.ndjson`. One `general-purpose` subagent running `echo`.

| #   | event                                       | `parent_tool_use_id` | notes                                                                               |
| --- | ------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| 16  | `assistant` → `tool_use` **`Agent`**        | `null`               | input carries `subagent_type`, `description`, **`run_in_background`**               |
| 17  | `system.task_started`                       | `null`               | `task_id`, **`tool_use_id`**, `subagent_type`, `task_type: "local_agent"`, `prompt` |
| 18  | `user` (the subagent's prompt)              | **`toolu_01Hyx…`**   |                                                                                     |
| 20  | `system.task_progress`                      | `null`               | `usage {total_tokens, tool_uses, duration_ms}`, `last_tool_name`                    |
| 21  | `assistant` → `tool_use` `Bash`             | **`toolu_01Hyx…`**   | the subagent's own tool call                                                        |
| 22  | `user` → `tool_result`                      | **`toolu_01Hyx…`**   | the subagent's own tool result                                                      |
| 23  | `system.task_updated`                       | `null`               | `patch: {status:"completed", end_time}`                                             |
| 24  | `system.task_notification`                  | `null`               | `status`, `summary`, `output_file`, `usage`                                         |
| 25  | `user` → `tool_result` for the `Agent` call | `null`               | the subagent's report re-enters the parent; carries `agentId:`                      |
| 34  | `result.success`                            | `null`               | turn ends                                                                           |

### The correlation keys

**`parent_tool_use_id` is the nesting signal, and it is complete.** Every message produced _inside_ a
subagent carries `parent_tool_use_id` = the `Agent` tool_use id that spawned it. Main-agent messages
carry `null`. Nothing else is needed to attribute a message to a subagent — no hooks, no heuristics.

The two id spaces join through `task_started`, which carries **both** `task_id` (`a969007280bdf804b`)
and `tool_use_id` (`toolu_01Hyx…`). So:

```
task_id  ←→  task_started.tool_use_id  ==  parent_tool_use_id on nested messages
```

## The backgrounded lifecycle — this is issue #38

`captures/subagent-backgrounded.ndjson`. Same thing with `run_in_background: true`.

```
[29] assistant  TOOL_USE Agent  run_in_background=True
[30] system.background_tasks_changed          ← roster changed
[31] system.task_started        a7af6055981f2b9a0
...
[76] result.success   <<<<<<<<<<  TURN ENDS
[77] result.success   <<<<<<<<<<  TURN ENDS (second result)
[78] system.background_tasks_changed          ← AFTER the turn ended
[79] system.task_updated  {task_id:"bshxkpls8", patch:{status:"killed", end_time:…}}
[80] system.task_notification {task_id:"bshxkpls8", status:"stopped"}
```

**Task lifecycle events keep arriving after `result`.** That is exactly the #38 shape, and it is not
a bug in T3 — it is how the protocol works. `run_in_background: true` is the trigger.

In this capture the background task was `killed` because `claude -p` exits when the turn ends. In
T3 the session is long-lived, so the work keeps running instead — which is how thread `3a85bdd3`
produced 1,358 activities across 33 minutes inside a turn the server had already closed.

Note also the **two `result` messages** (`num_turns=2`, then `num_turns=1`). Any logic that assumes
one `result` per turn should be checked against this.

> **SUPERSEDED IN PART, 2026-08-07.** Everything below about the _wire protocol_ is still accurate —
> it is captured, not inferred. But the "what T3 discards" table describes `main` only. Upstream
> landed **#5219 `feat: native subagent & workflow observability`** (`a2ca89aa1`, 2026-08-06, +598
> lines in `ClaudeAdapter.ts`) which already implements every gap this document identifies:
> `parent_tool_use_id` → owning-agent resolution, `task_updated` incl. `is_backgrounded`,
> `background_tasks_changed`, a new `ThreadBackgroundLivenessService`, and — decisively —
> **`backgroundLiveness: "working" | "monitoring" | null` on the thread-shell contract**
> (`packages/contracts/src/orchestration.ts:454`), populated by the same `getThreadShellById` read
> Loop Watch already performs (`ProjectionSnapshotQuery.ts:2336-2342`). CodexAdapter got it too, so
> it is cross-provider.
>
> **Do not build a fork-local open-task roster.** Once the sync lands, guard #15 is one field read:
> `if (shell.backgroundLiveness !== null) return skip("background work in flight")`. Building the
> roster would have been a textbook parallel path — a fork capability duplicating an upstream one,
> silently bypassing its guards. See `docs/t3x/SEAMS.md`.
>
> Note upstream made the same restart tradeoff this design did: the registry is in-memory and empty
> after a restart, on the reasoning that "orphaned background work is not live". So the durable
> `updated_at` timer is still required as the backstop.

## What T3 Code does with all of this today

| wire event                 | T3 handling                                    | file:line               |
| -------------------------- | ---------------------------------------------- | ----------------------- |
| `task_started`             | mapped → `task.started`                        | `ClaudeAdapter.ts:2681` |
| `task_progress`            | mapped → `task.progress` + token usage         | `:2692`                 |
| `task_updated`             | **dropped** — `case "task_updated": return;`   | `:2716`                 |
| `task_notification`        | mapped → `task.completed`                      | `:2718`                 |
| `background_tasks_changed` | **swallowed**                                  | `:2597`                 |
| `parent_tool_use_id`       | read **only** to discard subagent token deltas | `:2082`                 |

So T3 knows a task started and that one finished, but it does **not** maintain an open-task roster,
does **not** know a task was backgrounded, and does **not** attribute any nested message to the
subagent that produced it.

Three fields are being thrown away that answer #38 directly:

1. **`task_updated.patch`** — typed as
   `{status?: 'pending'|'running'|'completed'|'failed'|'killed'|'paused', description?, end_time?,
total_paused_ms?, error?, is_backgrounded?}` (`sdk.d.ts:4086-4093`). `is_backgrounded` is the flag
   that says "this will outlive the turn". `killed`/`failed` are terminal states `task_notification`
   may never report.
2. **`background_tasks_changed`** — the authoritative roster-changed signal.
3. **`parent_tool_use_id`** — free, complete subagent attribution.

## What this means for Loop Watch (#38)

The design currently infers liveness from `projection_threads.updated_at` staleness, because the
premise was that T3 cannot know whether background work is still in flight. **It can.**

Maintaining an open-task set from `task_started` / `task_updated` / `task_notification`, keyed on
`task_id`, gives an exact answer at turn-completion time: _is this run finished, or is it paused with
N subagents still working?_ That is strictly better evidence than a silence timer, and it removes the
worst failure mode in the current design — a nudge fired at a thread that is genuinely mid-flight but
quiet.

It does not replace the idle timer. Two reasons the timer stays:

- The roster is **hot-stream state**. A server restart loses it; `updated_at` is a SQL column that
  survives. Keep the timer as the durable backstop and use the roster as a _veto_ on firing.
- A task that is `killed` by a provider crash may never emit `task_notification`, so an open-task set
  still needs a TTL. (`task_updated{status:"killed"}` covers the clean case — which is precisely the
  event T3 currently drops.)

Recommended revision to #38's guard table: add **"no open tasks in the roster"** as a precondition
for nudging, and surface open-task count in the pill (`Loop paused — 3 subagents working`) instead of
the current binary working/stalled.

The `Stop` hook's `background_tasks` roster (`BackgroundTaskSummary {id, type: shell|subagent|monitor|
workflow, status, description, command?, agent_type?}`) is a second, independent source for the same
answer — but it requires `options.hooks`, which is a fresh edit to a churn-12 file. The wire events
above need **zero** new upstream surface: they are already flowing through a `switch` T3 owns the
arms of.

## Reproducing

```bash
claude -p "Use the Agent tool (subagent_type: general-purpose) to launch exactly ONE subagent. \
Its entire job: run the bash command 'echo hello-from-subagent' and report the output." \
  --output-format stream-json --verbose --permission-mode bypassPermissions \
  --model claude-haiku-4-5-20251001 < /dev/null > sub.ndjson
```

Add `with run_in_background: true` and "do not wait for it" to the prompt for the #38 shape.

Say **Agent tool**, not "Task tool" — the first attempt at this capture said "Task" and the model
reached for `TaskCreate` (the todo-list tool) instead of spawning anything.
