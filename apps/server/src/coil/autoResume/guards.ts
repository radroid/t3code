/**
 * Pure guard helpers for auto-resume.
 *
 * All predicates operate on the authoritative `OrchestrationThread` read-model snapshot
 * (the full-thread shape, which carries `messages` and `activities` — NOT the shell-only
 * derived flags). Keeping them pure makes every guard trivially unit-testable.
 *
 * @module coil/autoResume/guards
 */

import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * Baseline captured when a resume is scheduled, re-checked immediately before dispatch
 * to detect that the thread moved on.
 *
 * `newestUserMessageId` is recorded but is deliberately NOT a cancel condition — see the
 * block in `cancelReason` (radroid/t3code#39). It stays in the shape because it is part
 * of the persisted pending-resume record (`state.ts`), it is re-captured on every
 * (re)schedule, and it is what makes a stranded arm diagnosable from the state file.
 */
export interface GuardBaseline {
  readonly newestUserMessageId: string | null;
  readonly latestTurnId: string | null;
}

/** Id of the newest `role:"user"` message, or null. Messages are in append order. */
export function newestUserMessageId(thread: OrchestrationThread): string | null {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const message = thread.messages[i];
    if (message && message.role === "user") return message.id;
  }
  return null;
}

export function captureBaseline(thread: OrchestrationThread): GuardBaseline {
  return {
    newestUserMessageId: newestUserMessageId(thread),
    latestTurnId: thread.latestTurn?.turnId ?? null,
  };
}

/**
 * Blocked-on-you work derived from retained activities: an approval or user-input
 * request with no later resolution for the same requestId.
 *
 * LOGIC MIRROR of the private `hasOpenBlockingRequest` in
 * `apps/server/src/orchestration/decider.ts` (see docs/coil/SEAMS.md). Kept faithful so
 * auto-resume never fires into a pending prompt. If upstream adds a new blocking-request
 * activity kind, this must be updated in lockstep.
 */
export function hasOpenBlockingRequest(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

/**
 * The thread's session is backed by the Claude driver. The driver slug is
 * `"claudeAgent"` (ClaudeAdapter.ts:96); `session.providerName` is set from
 * `event.provider` (ProviderRuntimeIngestion.ts:1442).
 */
export const CLAUDE_DRIVER_KIND = "claudeAgent";
export function isClaudeThread(thread: OrchestrationThread): boolean {
  const name = thread.session?.providerName;
  return typeof name === "string" && name.toLowerCase() === CLAUDE_DRIVER_KIND.toLowerCase();
}

/** The thread is deleted, archived, or explicitly settled by the user. */
export function threadIsGone(thread: OrchestrationThread): boolean {
  return (
    thread.deletedAt !== null || thread.archivedAt !== null || thread.settledOverride === "settled"
  );
}

/** The thread is actively working (or spinning up) — resuming would double up. */
export function threadIsProgressing(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return true;
  return thread.latestTurn?.state === "running";
}

/**
 * The armed resume being re-checked: the baseline, plus the window it is waiting on.
 *
 * `PendingResume` (state.ts) already satisfies this structurally, so `Reactor.fireOne`
 * passes its pending record straight through. Nothing new is persisted, so the on-disk
 * state schema — and the whole-file-decode hazard documented on `ThreadRecord.enabled` —
 * is untouched.
 *
 * Required, not optional. An optional window would leave a second, weaker meaning of
 * "advancement" alive for a caller that does not exist (the reactor is the only
 * production caller), and this guard has now been wrong three times precisely because
 * one ambiguous fact was allowed to stand in for another.
 */
export interface ResumeArm {
  readonly baseline: GuardBaseline;
  /**
   * When the arm is due, i.e. when the blocked window reopens: `resetsAt` + the safety
   * margin (decide.ts), or `now + backoff` when the provider named no reset time.
   */
  readonly resumeAtMs: number;
}

/** Epoch ms for an ISO timestamp, or null when it is absent or unparseable. */
function isoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Positive evidence that a turn did work the closed window could not have blocked: it
 * ended at or after the moment that window reopened.
 *
 * A turn with no usable `completedAt` returns false — "no proof", not "advancement".
 * Cancelling is the destructive move, so absent evidence must never cancel; that is the
 * same rule #6 and #39 bought, applied to timing. In production that branch is
 * unreachable anyway: a turn that has not completed is `running`, which `threadIsProgressing`
 * catches before this is ever called, and 0 of 764 settled turns in the live projection
 * have a null `completed_at`.
 *
 * CLOCK PROVENANCE: `resumeAtMs` comes from `Clock.currentTimeMillis` and the turn
 * timestamps from the projection, which the same process wrote — consistent in
 * production. NOT consistent under `TestClock`, which starts at epoch 0 while a realistic
 * ISO timestamp is ~1.79e12, so a fixture that scripts real-world turn times against a
 * test-clock arm reads every turn as post-window and silently restores the incident.
 * Script turn times relative to the test clock, or leave them unset.
 */
function turnOutlivedClosedWindow(
  turn: { readonly completedAt?: string | null },
  reopensAtMs: number,
): boolean {
  const completedAtMs = isoMs(turn.completedAt);
  if (completedAtMs === null) return false;
  return completedAtMs >= reopensAtMs;
}

export type CancelReason =
  | "thread-gone"
  | "not-claude"
  | "progressing"
  | "awaiting-input"
  | "thread-advanced";

/**
 * Re-checked immediately before dispatch against a fresh snapshot. Returns a reason to
 * cancel the pending resume, or null when it is still safe to resume.
 */
export function cancelReason(thread: OrchestrationThread, arm: ResumeArm): CancelReason | null {
  if (threadIsGone(thread)) return "thread-gone";
  if (!isClaudeThread(thread)) return "not-claude";
  if (threadIsProgressing(thread)) return "progressing";
  if (hasOpenBlockingRequest(thread.activities)) return "awaiting-input";
  // A new user message does NOT cancel (radroid/t3code#39). This branch used to read
  // `newestUserMessageId(thread) !== baseline.newestUserMessageId` and return
  // "user-took-over", which is the same negative-evidence mistake #6 fixed one line
  // below: "a message exists that wasn't there when we armed" is not evidence that the
  // human took the wheel. In practice it is the opposite — the message that trips it is
  // typed the moment the usage-limit banner appears, which is exactly when someone is
  // stepping away ("keep going through the night"). That message is then usually rejected
  // by the same limit, so it starts nothing, and the wake tick destroys the only pending
  // resume. Measured on this install: 4 of 17 armed resumes (~24%) lost this way.
  //
  // Everything the branch was reaching for is still covered:
  //   * the user is actively driving right now      -> `progressing`
  //   * the thread is blocked on a prompt           -> `awaiting-input`
  //   * a different turn is live at fire time       -> `thread-advanced`
  //   * the user wants no resume at all             -> the per-thread switch, honoured
  //                                                    in `Reactor.fireOne`.
  //
  // Advancement needs POSITIVE evidence that the thread moved on. Two things look like
  // that evidence and are not. Each cost an incident, and all three incidents in this
  // feature are the same bug: one ambiguous fact read as "the human took the wheel".
  //
  // 1. `latestTurn: null` (radroid/t3code#6). Null means the join found no retained turn
  //    row — "no turn to report" — not "the thread moved on". Cancelling on it killed
  //    every real resume, so null still short-circuits first and never cancels.
  //
  //    CORRECTION, verified against the live projection on 2026-08-18: the reason this
  //    comment used to give — that `latest_turn_id` is populated only while a turn is
  //    active — is FALSE. `ProjectionPipeline` writes `activeTurnId ?? existingRow.latestTurnId`
  //    ("a terminal session must not erase history") and only recomputes it on
  //    `thread.reverted`, so a COMPLETED turn stays latest forever. All 63 threads that
  //    have a `latest_turn_id` point at a turn in state `completed`, including the
  //    incident thread. #6's rule stands; only its explanation was wrong.
  //
  // 2. A different, non-null turn id (2026-08-18). While the window is shut every
  //    provider request is rejected by construction, so a turn that ended before the
  //    window reopened cannot be the thread moving on — it IS the blockage, observed
  //    again. The incident's turn 64f7c4b7 was not even the user's: no user message drove
  //    it (`pending_message_id` NULL), it ran 508ms (19:34:44.276 -> .784) against a
  //    five_hour window that did not reopen until 19:50, and its only output was the
  //    assistant line "You've hit your session limit · resets 3:50pm". Comparing ids
  //    alone read that as a takeover and destroyed the one arm that would have restarted
  //    the thread — a whole night's work lost.
  //
  //    NEGATIVE RESULTS, so nobody rebuilds a broken signal that still passes the replay
  //    test: the doomed turn reached `state: "completed"`, DID carry an
  //    `assistantMessageId`, and DID take a checkpoint (turn_count 2, status ready). Turn
  //    state, "produced no output", "took no checkpoint", turn counts and message counts
  //    are all disproven as discriminators.
  //
  // This also subsumes #39's follow-on shape. The "keep going" typed at the banner is
  // rejected by the same limit and settles in half a second; today #39's fix survives
  // only because that turn usually does not become `latest_turn_id`. Requiring the turn
  // to outlive the window kills both shapes with one predicate, so #39 stops depending
  // on luck.
  //
  // KNOWN APPROXIMATION. The discriminator that actually names the class is
  // `projection_turns.pending_message_id IS NULL` ("the user did not start this turn") —
  // provider-synthesized turns are not rare here, 180 of 764, and 9 of 63 threads
  // currently point `latest_turn_id` at one. It is unreachable from `OrchestrationThread`
  // (`OrchestrationLatestTurn` has no `pendingMessageId`, and user messages are stored
  // with `turn_id = NULL`, so the read model cannot join one either); exposing it means
  // editing `packages/contracts` + `ProjectionSnapshotQuery`, i.e. permanent rebase tax
  // for this fork. Timing is the best in-fork proxy, not the right long-term model —
  // price the contract change before inventing a fourth proxy.
  //
  // TWO ACCEPTED COSTS, both chosen rather than overlooked:
  //   * `resumeAtMs` is `resetsAt + safetyMarginMs`, not the true reopen, and for a
  //     backoff-derived arm it is `now + ladder`, a guess rather than a known-shut
  //     interval. So a turn genuinely done in that margin reads as doomed. It errs toward
  //     firing on an idle thread, which is the cheap direction (#39 already priced a
  //     redundant nudge against a lost night). Persisting the raw `resetsAtMs` would make
  //     it exact and is not worth a `PendingResume` schema field.
  //   * `thread-advanced` now fires only for a post-window turn, so on a `seven_day` arm
  //     days of genuine user work can pass and we still inject "continue". The remaining
  //     brakes are `progressing`, `awaiting-input`, the per-thread switch, and the 24h cap.
  const currentTurn = thread.latestTurn ?? null;
  if (
    currentTurn !== null &&
    currentTurn.turnId !== arm.baseline.latestTurnId &&
    turnOutlivedClosedWindow(currentTurn, arm.resumeAtMs)
  ) {
    return "thread-advanced";
  }
  return null;
}
