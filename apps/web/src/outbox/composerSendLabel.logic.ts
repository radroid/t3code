import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

/**
 * Ported from apps/mobile/src/features/threads/composerSendLabel.ts, and since
 * diverged: web steers where mobile still queues (see `canSteerActiveThread`).
 *
 * The composer's send affordance doubles as a queue affordance. The button
 * label mirrors which one a submit will do, so the user knows whether pressing
 * it (or hitting Return) dispatches now or holds for later.
 *
 * Returns "Queue" only when the message genuinely cannot go out now, and "Send"
 * whenever it will — including *into* a running turn, which the provider folds
 * into the work in progress.
 */
export function resolveComposerSendLabel(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly activeThreadBusy: boolean;
  readonly queueCount: number;
  /**
   * Whether the thread is busy in a way the provider can absorb right now —
   * i.e. a running turn on a steer-capable driver. A busy thread is not on its
   * own a reason to queue: the adapter folds a mid-turn send into the running
   * turn rather than opening a competing one. Omitted (or false) keeps the
   * original hold-while-busy behaviour.
   */
  readonly canSteerActiveThread?: boolean;
}): "Send" | "Queue" {
  // Nothing can be dispatched without a connection.
  if (input.connectionState !== "connected") {
    return "Queue";
  }
  // Something is already waiting: sending now would jump the queue and deliver
  // this message ahead of ones the user wrote first.
  if (input.queueCount > 0) {
    return "Queue";
  }
  if (input.activeThreadBusy && input.canSteerActiveThread !== true) {
    return "Queue";
  }
  return "Send";
}
