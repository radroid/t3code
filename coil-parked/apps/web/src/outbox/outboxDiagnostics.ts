import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

/**
 * Greppable breadcrumbs for the composer's send-vs-queue behaviour.
 *
 * This path has two failure modes that leave no other trace:
 *
 *  - A message queues when the user expected it to go out now (or the reverse).
 *    The decision depends on connection phase, queue depth and turn phase, none
 *    of which are visible after the fact.
 *  - A send accepted by the command layer and then refused by the adapter.
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
  readonly phase: string;
  readonly queueCount: number;
  readonly connection: EnvironmentConnectionPhase;
  /** What the composer's picker resolved to — display state, not routing. */
  readonly provider: ProviderDriverKind | null;
  readonly threadId: ThreadId | null;
}

/**
 * One line per composer submit **that actually dispatched**, recording which
 * way it went and every input to that decision.
 *
 * Call this at each path's real dispatch point, never at the top of the submit
 * handler: a breadcrumb that also fires for submits a guard rejected (empty
 * composer, thread still loading, send already in flight) is worse than none,
 * because it is the only client-side evidence anyone has during triage.
 */
export function logComposerDispatch(input: ComposerDispatchDiagnostics): void {
  const decision = input.queued ? "queue" : "send";
  console.info(`${PREFIX} composer dispatch: ${decision}`, {
    decision,
    phase: input.phase,
    connection: input.connection,
    provider: input.provider,
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
