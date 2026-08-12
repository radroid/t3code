/**
 * Server-side attention edge detection for Web Push.
 *
 * A local port of the web client's `apps/web/src/notifications/needsAttention.logic.ts`, so
 * closed-tab push announces the exact same transitions the in-page coordinator does. It
 * edge-detects on the COMPUTED phase (via `projectThreadAwareness`) rather than raw event
 * types, which is inherently robust against the premature-"Done" problem: a stale
 * `completed` observed while a new turn is being requested equals the previous `completed`
 * and so never fires. Deliberately duplicated across the fork seam (a ~20-line pure function)
 * rather than importing web-app internals into the server.
 *
 * @module coil/webPush/attention
 */

import type { AgentAwarenessPhase, AgentAwarenessState } from "@t3tools/shared/agentAwareness";

export type AttentionKind = "waiting_for_approval" | "waiting_for_input" | "completed";

/** The push payload the service worker renders; mirrors the web `AttentionEvent`. */
export interface AttentionPushPayload {
  readonly title: string;
  readonly body: string;
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly kind: AttentionKind;
}

export function attentionKey(environmentId: string, threadId: string): string {
  return `${environmentId}::${threadId}`;
}

/**
 * Which transitions announce. Same two rules as the web tracker: `waiting_*` announce on
 * entry; `completed` announces only out of `running` (threads are born reading as
 * `completed`, so any other rule announces a "Done" for work that never ran).
 */
export function attentionKindForEdge(
  previousPhase: AgentAwarenessPhase | null,
  phase: AgentAwarenessPhase,
): AttentionKind | null {
  switch (phase) {
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "waiting_for_input":
      return "waiting_for_input";
    case "completed":
      return previousPhase === "running" ? "completed" : null;
    default:
      return null;
  }
}

export interface AttentionEdgeTracker {
  /** Feed a thread's latest phase (null when unresolved); returns a kind on a firing edge. */
  readonly observe: (threadId: string, phase: AgentAwarenessPhase | null) => AttentionKind | null;
  /** Drop a thread's tracked phase so a re-created thread is first-seen again. */
  readonly forget: (threadId: string) => void;
}

/**
 * Edge-detects phases per thread. A thread's first observation never fires (it replays state
 * that was already true), matching the web tracker so a server restart does not re-announce
 * every thread that happens to be waiting.
 */
export function createAttentionEdgeTracker(): AttentionEdgeTracker {
  const phases = new Map<string, AgentAwarenessPhase | null>();
  return {
    observe(threadId, phase) {
      const wasTracked = phases.has(threadId);
      const previous = phases.get(threadId) ?? null;
      phases.set(threadId, phase);
      if (!wasTracked || phase === previous || phase === null) {
        return null;
      }
      return attentionKindForEdge(previous, phase);
    },
    forget(threadId) {
      phases.delete(threadId);
    },
  };
}

/** Builds the push payload from an awareness state + the firing edge. */
export function buildAttentionPayload(
  state: AgentAwarenessState,
  kind: AttentionKind,
): AttentionPushPayload {
  const environmentId = String(state.environmentId);
  const threadId = String(state.threadId);
  return {
    title: state.headline,
    body: `${state.projectTitle} · ${state.threadTitle}`,
    key: attentionKey(environmentId, threadId),
    environmentId,
    threadId,
    kind,
  };
}
