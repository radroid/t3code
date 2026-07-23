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

One new reactor following the exact pattern of the three existing reactors
(`OrchestrationReactor`, `CheckpointReactor`, `ThreadDeletionReactor`): a `Services/`
interface + a `Layers/` implementation, dependency-injected, started in a scoped fiber.

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

## B2. Detection — authoritative poll, not the lossy stream

The read model (`OrchestrationThread`) exposes everything needed, untruncated:

- `session.status` ∈ {idle, starting, running, ready, interrupted, stopped, **error**}
- `session.lastError` — `NullOr(TrimmedNonEmptyString)`, assigned straight from
  `payload.errorMessage`/`payload.reason` with **no truncation**
  (`ProviderRuntimeIngestion.ts:1409`)
- `session.activeTurnId`, `session.providerName`
- `latestTurn.state` ∈ {running, interrupted, completed, **error**}, `latestTurn.completedAt`
- `archivedAt`, `deletedAt`, `settledOverride` — for guards

**The supervisor fiber ticks every 30s and calls `ProjectionSnapshotQuery.getSnapshot()`.**
For each thread it finds where `session.status === "error"` (or `latestTurn.state ===
"error"`), it runs `session.lastError` through `classifyLimitError`. Detection latency
≤30s is irrelevant for a feature that then waits hours, and this path is **immune to
event-delivery loss** — no second subscriber to the runtime PubSub, no event-tag
guesswork.

> Chosen over event subscription precisely because upstream flags the runtime stream as
> lossy for extra subscribers. Polling the projection is the same reliability move
> `CheckpointReactor` makes when it prefers domain events over runtime events.

## B3. Classification — `classifyLimitError` (pure, fixture-tested)

The **only** place that knows the vendor's message format, isolated so it's the single
thing to update if wording rots.

```
classifyLimitError(text: string | null): { kind: "usage-limit"; resetAt: Date | null } | undefined
```

- Returns `undefined` for non-limit errors (auto-resume ignores them).
- Matches known usage-limit wordings and `rate_limit_error` / 429 shapes.
- Extracts a reset timestamp when present; returns `resetAt: null` when it can't parse
  one (wording changed, message clipped) — **this is not a failure**, B4 handles it.
- Table-driven tests over real limit-message samples + malformed inputs.

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

Guards — each cancels or blocks a pending resume:

- **User took over** — any manual message / interrupt / revert on the thread since the
  resume was scheduled → clear the pending resume. Never fight the user.
- **Awaiting input/approval** — turn ended asking the user something → do nothing
  (the explicit v1 exclusion).
- **Thread gone** — `deletedAt`/`archivedAt` set, or settled by hand.
- **Provider gate** — only act on Claude threads in v1 (`session.providerName`).
- **Caps** — max consecutive auto-resumes per thread (default 10) and max per rolling
  24h; on exhaustion, stop and say so rather than loop forever.
- **Re-arm safety** — after a resume fires, don't re-detect the *same* error instance
  (track the `lastError`/turn identity that triggered it).

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

- `classifyLimitError`: table-driven fixtures (real limit wordings, 429 payloads,
  malformed/clipped, non-limit errors → `undefined`).
- Scheduling: `TestClock` drives the full detect → wait → wake → dispatch cycle;
  multi-hour waits verified in ms.
- Guards: one case each — user-took-over, awaiting-approval, archived/deleted, caps
  exhausted, non-Claude provider, backoff-when-resetAt-null.
- Durability: state survives a simulated restart (rehydrate from JSON).
- Integration: stub provider emits a usage-limit failure into the projection; assert a
  single `thread.turn.start` is dispatched **only after** the clock passes `resumeAt`,
  and not at all if a guard trips.

## B10. Config surface (env / t3x settings, all optional)

- `T3X_AUTO_RESUME_ENABLED` (default true)
- `T3X_AUTO_RESUME_POLL_MS` (default 30_000)
- `T3X_AUTO_RESUME_MAX_ATTEMPTS` (default 10)
- `T3X_AUTO_RESUME_SAFETY_MARGIN_MS` (default 60_000)

Read once at layer construction; sensible defaults mean the feature works with zero
configuration.

## Open implementation detail (resolved during recon)

The earlier "which domain event fires on turn failure" unknown is **moot**: there is no
turn-failed domain event, so detection polls the projection (B2). No spike needed.
