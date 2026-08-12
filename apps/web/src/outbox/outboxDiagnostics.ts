import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

/**
 * Greppable breadcrumbs for the composer's send-vs-queue behaviour.
 *
 * This path has two failure modes that leave no other trace:
 *
 *  - A message queues when the user expected it to go out now (or the reverse).
 *    The decision depends on connection phase, queue depth, turn phase and the
 *    provider's steering support, none of which are visible after the fact.
 *  - A steer is accepted by the command layer and then refused by the adapter.
 *    `providerService.sendTurn` is forked in ProviderCommandReactor, so the
 *    client's command has already succeeded; nothing on the client knows.
 *
 * Matches the `[thread-outbox]` prefix and structured-field shape the rest of
 * the module already uses (threadOutboxStorage, threadOutboxManager,
 * useThreadOutboxDrain), so one filter catches every outbox log line.
 */

const PREFIX = "[thread-outbox]";

export interface ComposerDispatchDiagnostics {
  readonly queued: boolean;
  readonly steerable: boolean;
  readonly phase: string;
  readonly queueCount: number;
  readonly connection: EnvironmentConnectionPhase;
  /** What the composer's picker resolved to — display state, not routing. */
  readonly provider: ProviderDriverKind | null;
  /**
   * The thread's persisted routing binding, which is what the steer allowlist
   * actually consults. Logged separately from `provider` because the two can
   * disagree — a disabled or unrecognised instance makes the picker fall back
   * to the first enabled provider — and that divergence was itself the bug in
   * radroid/t3code#40 A4. Seeing both makes it visible in one line.
   */
  readonly steerProvider: string | null;
  readonly threadId: ThreadId | null;
}

/**
 * One line per composer submit **that actually dispatched**, recording which
 * way it went and every input to that decision. `steer` is the case worth
 * grepping for: it is the only one that hands a message to a turn that is
 * already running.
 *
 * Call this at each path's real dispatch point, never at the top of the submit
 * handler: a breadcrumb that also fires for submits a guard rejected (empty
 * composer, thread still loading, send already in flight) is worse than none,
 * because it is the only client-side evidence anyone has during triage.
 */
export function logComposerDispatch(input: ComposerDispatchDiagnostics): void {
  const decision = input.queued ? "queue" : input.steerable ? "steer" : "send";
  console.info(`${PREFIX} composer dispatch: ${decision}`, {
    decision,
    phase: input.phase,
    connection: input.connection,
    provider: input.provider,
    steerProvider: input.steerProvider,
    queueCount: input.queueCount,
    threadId: input.threadId,
  });
}

/**
 * A queue mutation that failed after the user asked for it.
 *
 * `update` covers the no-op case as well as a thrown one: the manager returns
 * `false` when the message has already left the queue, and that outcome is just
 * as invisible to the user as a rejection would be.
 */
export function logOutboxMutationFailure(
  operation: "reorder" | "update",
  fields: Readonly<Record<string, unknown>>,
  error: unknown,
): void {
  console.warn(`${PREFIX} ${operation} failed`, { ...fields, error });
}
