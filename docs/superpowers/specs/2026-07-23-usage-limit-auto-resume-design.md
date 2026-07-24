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
  _faster_, never _possible_. If parsing fails, bounded backoff still gets there.
- **Detection must be reliable, not lossy.** The provider runtime event stream is a
  shared `PubSub.unbounded` (`ProviderService.ts:215`); upstream's "lossy" caveat
  (`CheckpointReactor.ts:764`) is a _subscription-timing_ issue — `Stream.fromPubSub`
  only sees events published after it subscribes. Detection therefore **subscribes once
  at supervisor boot and holds it for the layer's lifetime**, which eliminates the timing
  gap; the unbounded PubSub never drops on backpressure. The **projection** stays
  authoritative for the wake-time guard re-check (B5), not for detection (B2 explains
  why a usage limit produces no failed turn, so the projection can't detect it).
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
  index.ts                          T3xLayerLive = AutoResumeReactorLive ∘ AutoResumeStoreLive
  autoResume/
    Reactor.ts                      self-starting supervisor: detect → schedule → resume
    classifyRateLimit.ts            pure structured decode: (rateLimits) => verdict | undefined
    decide.ts                       pure planSchedule: (verdict, hasPending, now, …) => plan
    guards.ts                       pure guard predicates (baseline, cancelReason, …)
    state.ts                        durable pending-resume store (atomic JSON; Context.Service)
    config.ts                       env config + resume-prompt resolution
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
`provider === "claudeAgent"` (the Claude driver slug, `ClaudeAdapter.ts:96`). When
`rate_limit_info.status === "rejected"`, capture
`{ threadId, resetsAt, rateLimitType }` and schedule a resume at `resetsAt` (+ margin).

Why this is reliable despite upstream's "lossy stream" caveat:

- `runtimeEventPubSub` is `PubSub.unbounded` (`ProviderService.ts:215`) — it never drops
  on backpressure. The caveat is a _subscription-timing_ issue (`Stream.fromPubSub` only
  sees events published after it subscribes). Subscribing **once at boot** and holding it
  eliminates that.
- Rate-limit status is emitted repeatedly and the `rejected` condition persists for the
  whole window, so the mechanism is **self-correcting**: if a resume fires too early and
  is still rejected, the SDK re-emits `rejected` → we reschedule with backoff.

No projection poll for _detection_. (The poll survives only for the wake/guard re-check
in B4/B5, where the read model genuinely is authoritative.)

## B3. Classification — `classifyRateLimit` (pure, structured, fixture-tested)

Structured decode, not string matching — far more robust than the original string
classifier:

```
classifyRateLimit(rateLimits: unknown):
  { rejected: boolean; resetsAtMs: number | null; rateLimitType: string | null; status: string } | undefined
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
- State: a versioned JSON file in the server state dir, written via existing
  `atomicWrite.ts`, keyed by thread:
  `threadId → { pending: { resumeAtMs, reason, scheduledAtMs, baseline } | null,
firedAtMs: number[], overridePrompt: string | null }`. `firedAtMs` backs both the
  24h cap and the backoff lookback. Mutations are serialized through a
  `SynchronizedRef` and persisted atomically inside the critical section.
  **No DB migration** — the migration registry is upstream-owned; adding to it would
  buy permanent conflict surface for something one small JSON file does fine.
  Boot rehydrate distinguishes _missing/corrupt_ (start empty, persist normally) from
  _present-but-unreadable_ (a transient I/O error on a file that may still hold valid
  state): in the latter case the store runs in-memory only for the session and **suppresses
  persistence**, so it never clobbers the still-valid file with an empty one.
- Wait target:
  - `resetsAt` present **and in the future** → `resumeAt = resetsAt + safety margin`.
  - `resetsAt` absent **or already in the past** (stale/persistent limit) → **bounded
    backoff ladder**: 15m → 30m → 60m (cap). The window reopens eventually and the resume
    lands. A past `resetsAt` is never reused as the wait target.
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
`messages` and `activities` arrays that the full-thread snapshot _does_ carry:

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
- **Caps** — max auto-resumes per thread per rolling 24h (default 10); on exhaustion,
  stop and say so rather than loop forever. The cap is checked **both at schedule time**
  (so a capped-out thread stops re-scheduling and stops posting misleading "scheduled"
  notes on every subsequent rejection) **and at fire time** (defence-in-depth).
- **Re-arm safety** — at most **one pending resume per thread**: a fresh rejection while
  one is already pending is ignored (`hasPending` short-circuits `planSchedule`). Repeated
  rejections are spaced on a **backoff ladder** (15m → 30m → 60m, capped) rather than
  deduped by an exact-match "trigger signature" — an earlier signature scheme was dropped
  in review because it was fragile (three separate bugs) and did nothing the
  one-pending-per-thread invariant plus backoff spacing don't do more simply. The attempt
  is **reserved** (pending cleared + fire recorded) _before_ dispatch, so a failed dispatch
  cannot tight-loop; only a genuinely new rejection event re-arms.

**Wake race (review #4).** detect→schedule→(hours)→wake→dispatch has no
optimistic-concurrency primitive (`thread.turn.start` carries no expected-version). The
supervisor therefore **re-reads `getSnapshot()` immediately before each dispatch** (fresh
per due item, not once per tick) and re-runs every guard against that snapshot, aborting
if the newest user-message id or the latest turn id changed since scheduling (the captured
baseline). This closes all but a sub-second residual race, which is documented and accepted
(worst case: one redundant turn, which the user can interrupt).

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

- on detect: _"Usage limit reached. Auto-resume scheduled for 3:47 PM."_
- on wake: _"Resuming now (attempt 2 of 10)."_
- on cap: _"Auto-resume stopped after 10 attempts."_

Renders in the timeline that already exists → **v1 ships no `apps/web` changes, no
contracts changes, no settings-schema changes.**

> **Superseded for `apps/web` only.** These timeline activities are still the baseline
> visibility, but v1.1 adds an actual control surface — a floating per-thread card with a
> status line, an on/off switch and a resume-message box — specified in
> `2026-07-24-t3x-autoresume-ui-design.md`. That adds one `apps/web` seam (a mount line in
> the thread route) and one server route seam; it still touches **no** contracts and no
> settings schema, so the rest of this section stands.

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
  non-Claude provider, backoff-when-resetAt-null, thread-advanced (latest turn changed).
- Scheduling (`planSchedule`): schedule at `resetsAt + margin`; skip when non-rejected;
  skip when already pending; skip when at the 24h cap; backoff from `now` when `resetsAt`
  is absent **or already in the past** (stale limit); ladder caps at its last rung. Backoff
  uses a non-zero `now` so the `now +` term is actually exercised.
- Durability: pending resumes survive a simulated restart (rehydrate from JSON); a corrupt
  or version-mismatched state file is treated as empty and never crashes boot; a
  present-but-unreadable state path runs in-memory and leaves the existing file intact.
- Integration (`TestClock`, real store): feed a synthetic `account.rate-limits.updated`
  (status rejected) event through the reactor; assert a single `thread.turn.start` fires
  **only after** the clock passes `resumeAt`, none if the user takes over first, and — when
  the resume dispatch itself fails — the attempt is still reserved (pending cleared, one
  fire recorded) so it does **not** tight-loop.

## B10. Config surface (env / t3x settings, all optional)

- `T3X_AUTO_RESUME_ENABLED` (default `true`)
- `T3X_AUTO_RESUME_POLL_MS` (default `30_000`)
- `T3X_AUTO_RESUME_MAX_PER_24H` (default `10`)
- `T3X_AUTO_RESUME_SAFETY_MARGIN_MS` (default `60_000`)
- `T3X_AUTO_RESUME_BACKOFF_MS` — comma-separated ladder used when `resetsAt` is absent
  (default `900000,1800000,3600000` = 15m/30m/60m; the last value is the cap)

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

### Second pass (deep adversarial review of the implementation)

A second, deeper review of the built code surfaced ten confirmed findings; all are fixed:

- **Signature-based dedup was fragile (three bugs: stale re-fire, missed re-arm, cross-run
  collisions).** Removed the `triggerSignature`/`lastFiredSignature` machinery entirely.
  The invariant is now **one pending resume per thread** + **backoff spacing**; re-arming
  requires a genuinely new rejection event. Simpler and provably free of those three bugs.
- **Wake race re-read once per tick, not per item.** `fireOne` now re-reads a **fresh**
  `getSnapshot()` for each due item immediately before its own guard check + dispatch, so
  a dispatch earlier in the same tick can't leave a later item guarded against stale state.
- **A failed resume dispatch could tight-loop.** The attempt is now **reserved**
  (`recordFired` clears pending + logs the fire) _before_ dispatch; a dispatch failure is
  logged and does not retry until a new rejection arrives.
- **Backoff ignored `now` and treated a past `resetsAt` as future.** `planSchedule` adds
  the backoff offset to `now`, and only uses `resetsAt` when it is actually in the future;
  a stale/past `resetsAt` falls back to the ladder.
- **Corrupt/future-version state file could crash boot.** Decode failure and version
  mismatch both fall back to empty state (unit-tested).
- **`hasOpenBlockingRequest` mirror drift.** Verified byte-for-byte identical to the
  current `decider.ts`, recorded as a logic-mirror seam in `docs/t3x/SEAMS.md`, and unit-
  tested across all branches (open / resolved / stale-failure-clears / no-requestId).

Project-A workflow findings from the same pass (fixed in the fork-sync spec + scripts):
`gh issue list --jq '.[0].number'` prints literal `"null"` on an empty list → use
`// empty`; a dropped fork patch during rebase must escalate (new **exit 40**) instead of
force-pushing; the recovery tag is advertised only if its push to origin actually
succeeded.

### Third pass (verified review of the fixes; each finding double-confirmed)

A third review pass over the fixed code, with two independent skeptics verifying each
finding (and one — the merge-commit case — reproduced empirically with git), confirmed
three more issues; all fixed:

- **Merge commit on fork `main` permanently stalled the daily sync** (medium). The
  dropped-patch detector counted _all_ commits (`rev-list --count`), but a default rebase
  flattens merge commits, so the post-rebase count dropped with no real patch lost → false
  **exit 40** → the linearized result never pushed → the same false positive recurred
  every day. Fixed by counting **non-merge** commits (`--no-merges`), verified to still
  catch a genuinely absorbed patch.
- **Boot rehydrate could clobber valid durable state** (low). A transient read error
  (EACCES/EIO) was indistinguishable from a missing/corrupt file, so the store booted
  empty and the first write overwrote the still-valid file. Fixed by suppressing
  persistence when the file is present-but-unreadable (see B4).
- **24h cap was only enforced at fire time** (low). A capped-out thread kept re-scheduling
  and re-posting "scheduled"/"stopped" timeline notes on every subsequent rejection. Fixed
  by also checking the cap at schedule time in `planSchedule` (see B5 caps).

Two further candidates were investigated and **refuted** by the verifiers: (a) "swallowed
persist failure → duplicate resume after restart" — defeated by the `cancelReason` baseline
re-check against the durable, event-sourced thread state; (b) "unbounded state growth" —
real as over-retention but negligible at any realistic thread count (tiny records, pruned
fired-history), a low-priority hygiene item rather than a defect. Both are recorded here so
the reasoning isn't re-litigated later.
