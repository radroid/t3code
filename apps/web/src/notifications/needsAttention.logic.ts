import {
  projectThreadAwareness,
  type AgentAwarenessPhase,
  type AgentAwarenessState,
  type ProjectThreadAwarenessInput,
} from "@t3tools/shared/agentAwareness";

export type AttentionKind = "waiting_for_approval" | "waiting_for_input" | "completed";

export interface AttentionEvent {
  readonly key: string;
  readonly kind: AttentionKind;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
}

export function attentionKey(environmentId: string, threadId: string): string {
  return `${environmentId}::${threadId}`;
}

export interface AttentionTracker {
  /** Feed the full current set of thread inputs; returns newly-fired events. */
  update(inputs: ReadonlyArray<ProjectThreadAwarenessInput>): ReadonlyArray<AttentionEvent>;
}

/**
 * Edge-detects the phases of `projectThreadAwareness` so a chat that starts
 * needing the user is announced exactly once.
 *
 * Two rules keep it quiet. A key's first observation never fires, because the
 * initial snapshot replays state that was already true before the app opened.
 * And `completed` only fires out of `running`: threads are born at session
 * status `ready`, which the ladder projects as `completed`, so any other
 * approach announces a "Done" for work that never ran.
 */
export function createAttentionTracker(): AttentionTracker {
  let phases = new Map<string, AgentAwarenessPhase | null>();

  return {
    update(inputs) {
      const next = new Map<string, AgentAwarenessPhase | null>();
      const events: AttentionEvent[] = [];

      for (const input of inputs) {
        const key = attentionKey(input.environmentId, input.thread.id);
        const state = projectThreadAwareness(input);
        const phase = state?.phase ?? null;
        const wasTracked = phases.has(key);
        const previousPhase = phases.get(key) ?? null;
        next.set(key, phase);

        if (!wasTracked || phase === previousPhase || state === null) {
          continue;
        }
        const kind = attentionKindForEdge(previousPhase, state.phase);
        if (kind === null) {
          continue;
        }
        events.push({
          key,
          kind,
          environmentId: input.environmentId,
          threadId: input.thread.id,
          title: state.headline,
          body: attentionBody(state),
        });
      }

      // Replacing wholesale prunes keys absent from this update, so a thread
      // that comes back later is first-seen again rather than firing on the
      // stale phase it left behind.
      phases = next;
      return events;
    },
  };
}

function attentionKindForEdge(
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

function attentionBody(state: AgentAwarenessState): string {
  return `${state.projectTitle} · ${state.threadTitle}`;
}

export interface AttentionViewState {
  readonly hasFocus: boolean;
  readonly visible: boolean;
  readonly activeEnvironmentId: string | null;
  readonly activeThreadId: string | null;
}

/**
 * True only when the user is already staring at the chat that needs them.
 * Anything else — blurred window, hidden tab, a different chat on screen —
 * still deserves a notification.
 */
export function shouldSuppressAttentionEvent(
  event: AttentionEvent,
  view: AttentionViewState,
): boolean {
  return (
    view.visible &&
    view.hasFocus &&
    view.activeEnvironmentId === event.environmentId &&
    view.activeThreadId === event.threadId
  );
}
