import type { RemoteClientConnectionState } from "../../lib/connection";

/**
 * The composer's send affordance doubles as a queue affordance: every "send"
 * enqueues to the thread outbox, which sends-when-idle and holds-when-busy.
 * The button label mirrors that decision so the user knows whether pressing it
 * (or hitting Return) will dispatch now or queue for later.
 *
 * Returns "Queue" when the message cannot be delivered immediately — the
 * environment is not connected, or the outbox already holds messages — and
 * "Send" only when it will go out now.
 *
 * A busy thread is deliberately NOT a queue condition: upstream #6543 made the
 * mobile composer steer an active turn by default and removed `activeThreadBusy`
 * from `ThreadComposerProps` entirely. This helper mirrors that ternary, so it
 * follows.
 */
export function resolveComposerSendLabel(input: {
  readonly connectionState: RemoteClientConnectionState;
  readonly queueCount: number;
}): "Send" | "Queue" {
  if (input.connectionState !== "connected" || input.queueCount > 0) {
    return "Queue";
  }
  return "Send";
}
