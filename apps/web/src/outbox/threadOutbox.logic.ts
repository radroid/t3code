import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type MessageId as MessageIdType,
  type ModelSelection as ModelSelectionType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Web thread outbox model, ported from apps/mobile/src/state/thread-outbox-model.ts.
 *
 * Scoped to appending turns to already-existing threads: the mobile
 * "pending new-thread task" (offline thread creation) shape is intentionally
 * omitted, so there is no `creation` payload here. Image attachments are also
 * omitted because their blob-backed previews cannot survive a reload through
 * localStorage; queued web messages carry text plus a settings snapshot only.
 */

const THREAD_OUTBOX_SCHEMA_VERSION = 1;
const THREAD_OUTBOX_MAX_RETRY_DELAY_MS = 16_000;

export const QueuedThreadMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literals([THREAD_OUTBOX_SCHEMA_VERSION]),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  text: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  createdAt: IsoDateTime,
  /**
   * Queue position, written only once the user reorders the thread's queue.
   *
   * Deliberately optional so this stays schema version 1: a record persisted
   * before reordering existed still decodes, and `THREAD_OUTBOX_SCHEMA_VERSION`
   * is a `Schema.Literals` whose bump would make every older record throw —
   * which threadOutboxStorage swallows as "skip invalid", silently emptying the
   * user's queue on upgrade.
   *
   * Reordering cannot simply rewrite `createdAt`: that value is sent verbatim
   * as the turn-start command's timestamp, so it becomes the message's
   * permanent `createdAt`/`updatedAt` in server-side thread history and feeds
   * the client's queued-turn-start grace window.
   */
  sortKey: Schema.optional(Schema.String),
});

const decodeStoredQueuedThreadMessage = Schema.decodeUnknownSync(QueuedThreadMessageSchema);
const encodeStoredQueuedThreadMessage = Schema.encodeUnknownSync(QueuedThreadMessageSchema);
const QueuedThreadMessageJson = Schema.fromJsonString(QueuedThreadMessageSchema);
const decodeQueuedThreadMessageJson = Schema.decodeSync(QueuedThreadMessageJson);
const encodeQueuedThreadMessageJson = Schema.encodeSync(QueuedThreadMessageJson);

/**
 * Derived from the persisted schema (minus the on-disk `schemaVersion`) so the
 * in-memory shape and the decoded/encoded shapes stay exactly in sync under
 * `exactOptionalPropertyTypes`.
 */
export type QueuedThreadMessage = Omit<typeof QueuedThreadMessageSchema.Type, "schemaVersion">;

export interface ThreadSettingsSnapshot {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export function resolveQueuedThreadSettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot,
): ThreadSettingsSnapshot {
  return {
    modelSelection: message.modelSelection ?? thread.modelSelection,
    runtimeMode: message.runtimeMode ?? thread.runtimeMode,
    interactionMode: message.interactionMode ?? thread.interactionMode,
  };
}

export function modelSelectionsEqual(left: ModelSelectionType, right: ModelSelectionType): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) {
    return false;
  }
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) {
    return false;
  }
  return leftOptions.every((option, index) => {
    const other = rightOptions[index];
    return other !== undefined && option.id === other.id && option.value === other.value;
  });
}

export function encodeQueuedThreadMessage(message: QueuedThreadMessage): unknown {
  return encodeStoredQueuedThreadMessage({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function decodeQueuedThreadMessage(value: unknown): QueuedThreadMessage {
  const { schemaVersion: _schemaVersion, ...message } = decodeStoredQueuedThreadMessage(value);
  return message;
}

export function serializeQueuedThreadMessage(message: QueuedThreadMessage): string {
  return encodeQueuedThreadMessageJson({
    schemaVersion: THREAD_OUTBOX_SCHEMA_VERSION,
    ...message,
  });
}

export function parseQueuedThreadMessage(value: string): QueuedThreadMessage {
  const { schemaVersion: _schemaVersion, ...message } = decodeQueuedThreadMessageJson(value);
  return message;
}

/**
 * The value a queued message is ordered by. Enqueue order (`createdAt`) until
 * the user reorders the thread's queue, after which the explicit `sortKey`
 * wins. Both are compared as strings, which matches enqueue order because the
 * only producer of `createdAt` is `new Date().toISOString()` (fixed width, UTC).
 */
export function queuedThreadMessageOrderKey(message: QueuedThreadMessage): string {
  return message.sortKey ?? message.createdAt;
}

export function compareQueuedThreadMessages(
  left: QueuedThreadMessage,
  right: QueuedThreadMessage,
): number {
  const byOrderKey = queuedThreadMessageOrderKey(left).localeCompare(
    queuedThreadMessageOrderKey(right),
  );
  if (byOrderKey !== 0) {
    return byOrderKey;
  }
  // Two messages enqueued in the same millisecond carry identical keys, and
  // `load` returns them in localStorage key-enumeration order, which is
  // browser-defined — so without this tiebreak their relative order could flip
  // across a reload. Now that the order is user-visible and user-editable, it
  // has to be deterministic.
  return left.messageId.localeCompare(right.messageId);
}

export function groupQueuedThreadMessages(
  messages: ReadonlyArray<QueuedThreadMessage>,
): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  const deduplicated = new Map<MessageIdType, QueuedThreadMessage>();
  for (const message of messages) {
    deduplicated.set(message.messageId, message);
  }

  const grouped: Record<string, Array<QueuedThreadMessage>> = {};
  for (const message of deduplicated.values()) {
    const threadKey = scopedThreadKey(scopeThreadRef(message.environmentId, message.threadId));
    (grouped[threadKey] ??= []).push(message);
  }
  for (const queue of Object.values(grouped)) {
    queue.sort(compareQueuedThreadMessages);
  }
  return grouped;
}

export type QueuedThreadMessageMove = "up" | "down";

/**
 * The ordering slots a thread's queue currently occupies, made strictly
 * increasing. Reordering re-deals these same slots to the permuted queue rather
 * than inventing new keys, so a reordered message can never sort past one that
 * is enqueued later (a fresh `createdAt` is greater than every existing slot).
 *
 * The `#n` suffix disambiguates messages enqueued in the same millisecond;
 * without it a swap of two such messages would assign them equal keys and the
 * messageId tiebreak would silently undo the move.
 */
function orderingSlots(ordered: ReadonlyArray<QueuedThreadMessage>): ReadonlyArray<string> {
  const occurrences = new Map<string, number>();
  return ordered.map((message) => {
    const base = queuedThreadMessageOrderKey(message);
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  });
}

/**
 * Moves `messageId` one position within a single thread's queue, returning only
 * the messages whose persisted `sortKey` has to change (empty when the move is
 * a no-op — unknown message, or already at the end it is moving toward).
 */
export function reorderQueuedThreadMessages(
  queue: ReadonlyArray<QueuedThreadMessage>,
  messageId: MessageIdType,
  move: QueuedThreadMessageMove,
): ReadonlyArray<QueuedThreadMessage> {
  const ordered = [...queue].sort(compareQueuedThreadMessages);
  const index = ordered.findIndex((message) => message.messageId === messageId);
  if (index === -1) {
    return [];
  }
  const target = move === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ordered.length) {
    return [];
  }

  const slots = orderingSlots(ordered);
  const moved = [...ordered];
  const [entry] = moved.splice(index, 1);
  if (entry === undefined) {
    return [];
  }
  moved.splice(target, 0, entry);

  const changed: Array<QueuedThreadMessage> = [];
  moved.forEach((message, position) => {
    const sortKey = slots[position];
    // Compared against the *effective* key, not the raw field: a message that
    // keeps its place still orders correctly on its createdAt, so writing it an
    // explicit sortKey would just cost a storage round-trip.
    if (sortKey !== undefined && queuedThreadMessageOrderKey(message) !== sortKey) {
      changed.push({ ...message, sortKey });
    }
  });
  return changed;
}

export function flattenQueuedThreadMessages(
  queues: Record<string, ReadonlyArray<QueuedThreadMessage>>,
): ReadonlyArray<QueuedThreadMessage> {
  return Object.values(queues).flat();
}

export function threadOutboxRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), THREAD_OUTBOX_MAX_RETRY_DELAY_MS);
}

export type ThreadOutboxDeliveryAction = "wait" | "remove" | "send";

export function resolveThreadOutboxDeliveryAction(input: {
  readonly threadExists: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly environmentConnected: boolean;
  readonly threadBusy: boolean;
}): ThreadOutboxDeliveryAction {
  if (!input.threadExists) {
    // Wait for shell synchronization to complete before discarding: until the
    // thread list is live a still-syncing environment could simply not have
    // surfaced the thread yet.
    return input.shellStatus === "live" ? "remove" : "wait";
  }
  return input.environmentConnected && !input.threadBusy ? "send" : "wait";
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : null;
  }
  return typeof error === "string" ? error : null;
}

export function shouldRetryThreadOutboxDelivery(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ConnectionTransientError"
  ) {
    return true;
  }
  return isTransportConnectionErrorMessage(errorMessage(error));
}

export type ThreadOutboxCommandStage = "settings-sync" | "start-turn";
export type ThreadOutboxFailureAction = "retry" | "discard";

export function resolveThreadOutboxFailureAction(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
}): ThreadOutboxFailureAction {
  if (
    input.stage === "settings-sync" ||
    input.interrupted ||
    shouldRetryThreadOutboxDelivery(input.error)
  ) {
    return "retry";
  }
  return "discard";
}
