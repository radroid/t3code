import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

/**
 * Ported from apps/mobile/src/features/threads/composerSendLabel.ts.
 *
 * The composer's send affordance doubles as a queue affordance. The button
 * label mirrors which one a submit will do, so the user knows whether pressing
 * it (or hitting Return) dispatches now or holds for later.
 *
 * Returns "Queue" only when the message genuinely cannot go out now, and "Send"
 * whenever it will — including during a running turn, which upstream's
 * client-side queue (#11673) holds until the next tool boundary and steers in.
 */
export function resolveComposerSendLabel(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly queueCount: number;
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
  return "Send";
}
