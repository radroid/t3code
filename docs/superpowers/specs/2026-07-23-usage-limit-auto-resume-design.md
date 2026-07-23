# Usage-Limit Auto-Resume — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorming)
**Fork:** `radroid/t3code`
**Companion spec:** `2026-07-23-fork-upstream-sync-design.md` (Project A)

## Problem

Long-running loops and large sessions hit the provider's rolling usage-window limit
(the "5-hour window"). Today the user must return hours later and manually type
"continue" to resume. The goal: **when the window reopens, the thread resumes
automatically, with zero touches.**

## Scope

**In scope (v1):** usage-limit / window-exhausted only.

**Out of scope (recorded as future work, each additive inside `t3x/` at ~zero extra
upstream cost):**

- Stalled-turn watchdog (turn running but silent for N minutes).
- Session-crash / early-termination recovery.
- Auto-answering approval / input prompts (deliberately excluded — would silently
  approve things the user might decline).

## Design principles

- **No hard dependency on vendor string formats.** Parsing the reset time makes resume
  *faster*, never *possible*. If parsing fails, bounded backoff still gets there.
- **Detection must be reliable, not lossy.** The provider runtime event stream is a
  shared PubSub that upstream itself documents as unreliable for extra subscribers
  (`CheckpointReactor.ts:764`). Detection therefore reads the **authoritative
  projection**, not that stream.
- **Zero web-app / contracts / migration footprint in v1.** Visibility rides existing
  timeline activities; state is a plain atomic-written JSON file.

---

## B1. Shape & hook point

One new reactor. **Revised after review:** the three existing reactors
(`OrchestrationReactor`, `CheckpointReactor`, `ThreadDeletionReactor`) expose a
`start()` method that is fanned out explicitly in `OrchestrationReactor.start()`
(`Layers/OrchestrationReactor.ts:21-26`) and booted from `serverRuntimeStartup.ts:344` —
both **upstream-owned** files. Following that pattern would add 2 more seams and break
the "+2 lines" claim. So `AutoResumeReactor` instead **self-starts via
`Effect.forkScoped` at layer-construction time inside `T3xLayerLive`**: merging the
layer boots the supervisor with no external `.start()` call. Tradeoff: no explicit
`drain()` — the supervisor fiber is torn down by scope closure on shutdown, which is
fine for a background poller. This keeps the entire upstream footprint at the 2-line
`server.ts` seam.

```
apps/server/src/t3x/
  index.ts                          T3xLayerLive = Layer.mergeAll(AutoResumeReactorLive, …)
  autoResume/
    Service.ts                      interface (Context.Service tag)
    Reactor.ts                      supervisor loop: detect → schedule → resume
    classifyLimitError.ts           pure: (text) => { kind, resetAt? } | undefined
    state.ts                        durable pending-resume store (atomic JSON)
    config.ts                       resume-prompt resolution
    *.test.ts
```

Dependencies: `OrchestrationEngine` (to dispatch commands + read snapshot query),
`ProjectionSnapshotQuery` (authoritative read model), `Clock` (testable time),
filesystem via existing `atomicWrite.ts`.

## B2. Detection — the structured `account.rate-limits.updated` event

**Revised after review.** The original plan (poll the projection for `session.status
=== "error"` / `lastError`) is **wrong**: verified against the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk` v0.2.x), a usage-limit does **not** produce a failed
turn. `SDKResultError.subtype` is only `error_during_execution | error_max_turns |
error_max_budget_usd | error_max_structured_output_retries` — there is **no** rate-limit
result subtype — so the projection often shows `status:"ready"`, `lastError:null` on a
limit hit. Projection-error detection would silently never fire.

The real signal is structured. The SDK emits an `SDKRateLimitEvent`:

```ts
SDKRateLimitInfo = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;                      // epoch — exact reset time, no parsing
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus"
                | "seven_day_sonnet" | "overage";
  utilization?: number; ...
}
```

`ClaudeAdapter` maps this to the runtime event `account.rate-limits.updated`
(`ClaudeAdapter.ts:2906-2915`) with `payload.rateLimits` = the raw event, and every
runtime event carries `threadId` + `provider` (`providerRuntime.ts` `ProviderRuntimeEventBase`).

**Detection = subscribe once, at supervisor boot, to `providerService.streamEvents`**
(held for the layer's lifetime). Filter `type === "account.rate-limits.updated"` and
`provider === "claude"`. When `rate_limit_info.status === "rejected"`, capture
`{ threadId, resetsAt, rateLimitType }` and schedule a resume at `resetsAt` (+ margin).

Why this is reliable despite upstream's "lossy stream" caveat:

- `runtimeEventPubSub` is `PubSub.unbounded` (`ProviderService.ts:215`) — it never drops
  on backpressure. The caveat is a *subscription-timing* issue (`Stream.fromPubSub` only
  sees events published after it subscribes). Subscribing **once at boot** and holding it
  eliminates that.
- Rate-limit status is emitted repeatedly and the `rejected` condition persists for the
  whole window, so the mechanism is **self-correcting**: if a resume fires too early and
  is still rejected, the SDK re-emits `rejected` → we reschedule with backoff.

No projection poll for *detection*. (The poll survives only for the wake/guard re-check
in B4/B5, where the read model genuinely is authoritative.)

## B3. Classification — `classifyRateLimit` (pure, structured, fixture-tested)

Structured decode, not string matching — far more robust than the original string
classifier:

```
classifyRateLimit(rateLimits: unknown): { rejected: boolean; resetsAt: Date | null; rateLimitType: string | null } | undefined
```

- Defensively decodes the `payload.rateLimits` blob (reads `.rate_limit_info`).
- Returns `undefined` when the blob isn't a recognizable rate-limit info object.
- `resetsAt`: normalizes epoch seconds-vs-ms; returns `null` if absent — **not a
  failure**, B4's backoff handles it.
- Table-driven tests over real `SDKRateLimitInfo` shapes (rejected/allowed_warning/
  allowed, five_hour vs seven_day, missing resetsAt, malformed blob → `undefined`).

## B4. Scheduling & durability

- A **single supervisor fiber**, not one sleeping fiber per thread. It re-derives all
  pending resumes from disk on boot, so a server restart mid-wait loses nothing.
- State: a JSON file in the server data dir, written via existing `atomicWrite.ts`:
  `threadId → { resumeAt, attempts, lastReason, promptSource, createdAt }`.
  **No DB migration** — the migration registry is upstream-owned; adding to it would
  buy permanent conflict surface for something a ~40-line file does fine.
- Wait target:
  - `resetAt` parsed → `resumeAt = resetAt + small safety margin`.
  - `resetAt` null → **bounded exponential backoff**: 15m → 30m → 60m (cap). The window
    reopens eventually and the resume lands.
- Time via Effect `Clock`; tests drive multi-hour waits with `TestClock` in ms.
- **One pending resume per thread, ever.**

## B5. Resume & guardrails

At wake time, dispatch an ordinary `thread.turn.start` command with the resume text —
byte-for-byte the same path a keystroke produces (`decider.ts:591`). Provider respawn
and `--resume <session_id>` are already handled by `ClaudeAdapter`
(`ClaudeAdapter.ts:1455`), so **no provider work is needed** and a multi-hour idle (even
if the session reaper kills the process) reattaches transparently.

Guards — each cancels or blocks a pending resume. **Revised after review:** the full
`OrchestrationThread` snapshot does **not** carry the shell-only derived fields
(`latestUserMessageAt`, `pendingApprovalCount`, …). Guards must be recomputed from the
`messages` and `activities` arrays that the full-thread snapshot *does* carry:

- **User took over** — recomputed by scanning `thread.messages` for the newest
  `role:"user"` message and comparing its `createdAt`/id against the schedule time; also
  scan `thread.activities` for interrupt/revert kinds after the schedule time. Any →
  clear the pending resume. Never fight the user.
- **Awaiting input/approval** — recomputed via an **open-blocking-request** scan over
  `thread.activities` (`approval.requested`/`user-input.requested` with no later
  `*.resolved` for the same `requestId`). This faithfully mirrors the private
  `hasOpenBlockingRequest` in `decider.ts:57-80` (replicated in `guards.ts`, not
  imported, to avoid a seam — recorded in SEAMS.md as a logic-mirror to keep in step).
  Open request → do nothing (the explicit v1 exclusion).
- **Thread gone** — `deletedAt`/`archivedAt` set, or `settledOverride === "settled"`.
- **Provider gate** — only act on Claude threads in v1 (`session.providerName`).
- **Caps** — max consecutive auto-resumes per thread (default 10) and max per rolling
  24h; on exhaustion, stop and say so rather than loop forever.
- **Re-arm safety** — track a trigger signature (`threadId` + `resetsAt` +
  `rateLimitType`); the same rejection never reschedules twice. Only a *new* rejection
  (different `resetsAt`) after a resume re-arms.

**Wake race (review #4).** detect→schedule→(hours)→wake→dispatch has no
optimistic-concurrency primitive (`thread.turn.start` carries no expected-version). The
supervisor therefore **re-reads `getSnapshot()` immediately before dispatch** and
re-runs every guard against the fresh snapshot, and additionally aborts if
`session.updatedAt` or the newest user-message id changed since scheduling. This closes
all but a sub-second residual race, which is documented and accepted (worst case: one
redundant turn, which the user can interrupt).

## B6. Resume-prompt resolution (`config.ts`)

First match wins:

1. Per-thread override in t3x state (for a future UI/CLI to set).
2. **`<project-workspace-root>/.t3x/resume-prompt.md`** — a file committed in the repo
   the thread is working on. This is the ergonomic win: a loop repo checks in its own
   re-entry prompt once, and every thread on that project resumes correctly forever with
   no per-thread config.
3. Literal `"continue"` — reproduces today's manual behavior exactly.

## B7. Visibility — zero UI patch

The reactor appends to the existing thread timeline via the `thread.activity.append`
command (`decider.ts:972`), tone `info`/`error`:

- on detect: *"Usage limit reached. Auto-resume scheduled for 3:47 PM."*
- on wake: *"Resuming now (attempt 2 of 10)."*
- on cap: *"Auto-resume stopped after 10 attempts."*

Renders in the timeline that already exists → **v1 ships no `apps/web` changes, no
contracts changes, no settings-schema changes.**

## B8. Upstream footprint

```
apps/server/src/server.ts    +2 lines   (1 import of T3xLayerLive, 1 Layer.provideMerge)
────────────────────────────────────────
everything else              new files under apps/server/src/t3x/ (upstream-invisible)
```

This is the entire patch against upstream code, and it does **not** grow when feature
#2 is added (feature #2 registers inside `t3x/index.ts`).

## B9. Testing

- `classifyRateLimit`: table-driven fixtures over real `SDKRateLimitInfo` shapes
  (rejected/allowed_warning/allowed, five_hour vs seven_day, missing `resetsAt`, epoch
  s-vs-ms, malformed blob → `undefined`).
- Scheduling: `TestClock` drives the full detect → wait → wake → dispatch cycle;
  multi-hour waits verified in ms.
- Guards: one case each — user-took-over (new message after schedule), awaiting-approval
  (open blocking request in activities), archived/deleted/settled, caps exhausted,
  non-Claude provider, backoff-when-resetAt-null, wake-race (snapshot changed before
  dispatch → abort).
- Durability: pending resumes survive a simulated restart (rehydrate from JSON).
- Integration: feed a synthetic `account.rate-limits.updated` (status rejected) runtime
  event through the reactor; assert a single `thread.turn.start` is dispatched **only
  after** the clock passes `resumeAt`, and not at all if a guard trips.

## B10. Config surface (env / t3x settings, all optional)

- `T3X_AUTO_RESUME_ENABLED` (default true)
- `T3X_AUTO_RESUME_POLL_MS` (default 30_000)
- `T3X_AUTO_RESUME_MAX_ATTEMPTS` (default 10)
- `T3X_AUTO_RESUME_SAFETY_MARGIN_MS` (default 60_000)

Read once at layer construction; sensible defaults mean the feature works with zero
configuration.

## Review resolutions (adversarial review, 2026-07-23)

All four findings from the adversarial review are incorporated above:

1. **Detection existential risk (#1)** — CONFIRMED and fixed. A usage limit does not
   produce a failed turn (SDK has no rate-limit result subtype), so projection-error
   detection was wrong. Replaced with the structured `account.rate-limits.updated`
   event keyed on `rate_limit_info.status === "rejected"` + `resetsAt` (B2/B3).
2. **"+2 lines" false (#5)** — CONFIRMED. Sibling reactors need an explicit `.start()`
   in upstream files. Fixed by self-starting via `Effect.forkScoped` at layer
   construction (B1); footprint stays 2 lines.
3. **Guards read non-existent fields (#4)** — CONFIRMED. Rewritten to recompute from
   `messages`/`activities`, mirror `hasOpenBlockingRequest`, and re-read the snapshot
   before dispatch to close the wake race (B5).
4. **rerere-in-CI broken (#6)** — CONFIRMED for Project A; fixed in that spec (drop the
   CI rr-cache sharing claim; rerere stays local where conflicts are actually resolved).

Dispatching the resume (`thread.turn.start` from a reactor) was reviewed OK: it needs
only `commandId`/`threadId`/`message`/`createdAt`, has no actor field, and the decider
places no `session.status` guard on turn starts.
