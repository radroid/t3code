import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

/**
 * Ported from apps/mobile/src/features/threads/composerSendLabel.ts.
 *
 * The composer's send affordance doubles as a queue affordance: every "send"
 * enqueues to the thread outbox, which sends-when-idle and holds-when-busy.
 * The button label mirrors that decision so the user knows whether pressing it
 * (or hitting Return) will dispatch now or queue for later.
 *
 * Returns "Queue" when the message cannot be delivered immediately — the
 * environment is not connected, the active thread is still working, or the
 * outbox already holds messages — and "Send" only when it will go out now.
 */
export function resolveComposerSendLabel(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly activeThreadBusy: boolean;
  readonly queueCount: number;
}): "Send" | "Queue" {
  if (input.connectionState !== "connected" || input.activeThreadBusy || input.queueCount > 0) {
    return "Queue";
  }
  return "Send";
}
