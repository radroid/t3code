import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { createThreadOutboxManager } from "./threadOutboxManager";
import type { QueuedThreadMessage, QueuedThreadMessageMove } from "./threadOutbox.logic";
import { localThreadOutboxStorage } from "./threadOutboxStorage";

const EMPTY_QUEUE: ReadonlyArray<QueuedThreadMessage> = Object.freeze([]);

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: localThreadOutboxStorage,
});

/**
 * Loads the persisted queue exactly once. The manager caches the load promise,
 * so repeated calls (e.g. the drain remounting) are cheap.
 */
export function ensureThreadOutboxLoaded(): Promise<void> {
  return threadOutboxManager.load();
}

export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.enqueue(message);
}

export function updateThreadOutboxMessage(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.update(message);
}

/**
 * Moves a queued message one position within its thread's queue. Resolves
 * `false` when nothing moved (already at the end it is moving toward, or the
 * message was delivered/deleted in the meantime).
 */
export function moveThreadOutboxMessage(
  message: QueuedThreadMessage,
  move: QueuedThreadMessageMove,
): Promise<boolean> {
  return threadOutboxManager.reorder(message, move);
}

export function removeThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  return threadOutboxManager.remove(message);
}

/**
 * Discards every queued message belonging to an environment. Wired into the
 * environment-removal cleanup so forgetting a connection also drops its queue.
 */
export function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  return threadOutboxManager.clearEnvironment(environmentId);
}

/**
 * Shell status per environment that currently holds queued messages, so the
 * drain can decide whether a message for a not-yet-visible thread should keep
 * waiting or be discarded. Mirrors the mobile use-thread-outbox atom.
 */
const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("web:thread-outbox:shell-statuses"));

/**
 * Queued messages the drain must not deliver right now: any whose inline editor
 * is open. Editing sessions hold their message id here and release it once the
 * queued payload is saved back, so the drain never sends stale content.
 */
export const editingThreadOutboxMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("web:thread-outbox:editing-message-ids"));

export function holdEditingThreadOutboxMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingThreadOutboxMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingThreadOutboxMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingThreadOutboxMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingThreadOutboxMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingThreadOutboxMessageIdsAtom, next);
}

export function useThreadOutboxMessages(): Record<string, ReadonlyArray<QueuedThreadMessage>> {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

export function useThreadOutboxShellStatuses(): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> {
  return useAtomValue(threadOutboxShellStatusesAtom);
}

export function useThreadOutboxEditingIds(): Readonly<Record<MessageId, true>> {
  return useAtomValue(editingThreadOutboxMessageIdsAtom);
}

/** The FIFO-ordered queued messages for a single thread (empty when none). */
export function useThreadOutboxQueue(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<QueuedThreadMessage> {
  const grouped = useThreadOutboxMessages();
  return useMemo(() => {
    if (environmentId === null || threadId === null) {
      return EMPTY_QUEUE;
    }
    const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
    return grouped[key] ?? EMPTY_QUEUE;
  }, [grouped, environmentId, threadId]);
}
