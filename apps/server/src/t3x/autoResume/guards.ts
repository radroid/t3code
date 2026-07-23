/**
 * Pure guard helpers for auto-resume.
 *
 * All predicates operate on the authoritative `OrchestrationThread` read-model snapshot
 * (the full-thread shape, which carries `messages` and `activities` — NOT the shell-only
 * derived flags). Keeping them pure makes every guard trivially unit-testable.
 *
 * @module t3x/autoResume/guards
 */

import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * Baseline captured when a resume is scheduled, re-checked immediately before dispatch
 * to detect that the thread moved on (user took over, a new turn ran, etc.).
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
 * `apps/server/src/orchestration/decider.ts` (see docs/t3x/SEAMS.md). Kept faithful so
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
  | "user-took-over"
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
  if (newestUserMessageId(thread) !== baseline.newestUserMessageId) return "user-took-over";
  if ((thread.latestTurn?.turnId ?? null) !== baseline.latestTurnId) return "thread-advanced";
  return null;
}
