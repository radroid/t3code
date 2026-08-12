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
export function cancelReason(
  thread: OrchestrationThread,
  baseline: GuardBaseline,
): CancelReason | null {
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
  // Advancement needs POSITIVE evidence: a different, non-null turn id. The snapshot's
  // `latestTurn` is joined on `projection_threads.latest_turn_id`, which is populated
  // only while a turn is active — so a usage limit that lands mid-turn captures the
  // running turn's id in the baseline, and by fire time (turn settled, session idle)
  // the snapshot reports `latestTurn: null`. That null means "no active turn", not
  // "the thread moved on"; treating it as advancement cancelled every real resume
  // (radroid/t3code#6). A genuine user takeover is caught above via the newest user
  // message; active work is caught by `progressing`.
  const currentTurnId = thread.latestTurn?.turnId ?? null;
  if (currentTurnId !== null && currentTurnId !== baseline.latestTurnId) {
    return "thread-advanced";
  }
  return null;
}
