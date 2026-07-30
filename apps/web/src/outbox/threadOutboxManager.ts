import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type MessageId as MessageIdType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import {
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  reorderQueuedThreadMessages,
  type QueuedThreadMessage,
  type QueuedThreadMessageMove,
} from "./threadOutbox.logic";
import type { ThreadOutboxStorage } from "./threadOutboxStorage";

/**
 * Serialized (FIFO promise chain) mutations with storage write-through,
 * ported from apps/mobile/src/state/thread-outbox-manager.ts.
 */
export class ThreadOutboxManagerError extends Schema.TaggedErrorClass<ThreadOutboxManagerError>()(
  "ThreadOutboxManagerError",
  {
    operation: Schema.Literals([
      "load",
      "enqueue",
      "update",
      "reorder",
      "remove",
      "clear-environment-load",
      "clear-environment-remove",
    ]),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: Schema.NullOr(ThreadId),
    messageId: Schema.NullOr(MessageId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}.`;
  }
}

export interface ThreadOutboxManagerOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: ThreadOutboxStorage;
  readonly warn?: (message: string, error: unknown) => void;
}

export function createThreadOutboxManager(options: ThreadOutboxManagerOptions) {
  const queuedMessagesByThreadKeyAtom = Atom.make<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({}).pipe(Atom.keepAlive, Atom.withLabel("web:thread-outbox:queued-messages"));
  const warn =
    options.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error);
    });
  let loadPromise: Promise<void> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();

  const serialize = <A>(mutation: () => Promise<A>): Promise<A> => {
    const result = mutationQueue.then(mutation, mutation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentMessages = (): ReadonlyArray<QueuedThreadMessage> =>
    flattenQueuedThreadMessages(options.registry.get(queuedMessagesByThreadKeyAtom));

  const setMessages = (messages: ReadonlyArray<QueuedThreadMessage>): void => {
    options.registry.set(queuedMessagesByThreadKeyAtom, groupQueuedThreadMessages(messages));
  };

  const load = (): Promise<void> => {
    if (loadPromise !== null) {
      return loadPromise;
    }
    loadPromise = serialize(async () => {
      const persistedMessages = await options.storage.load();
      setMessages([...persistedMessages, ...currentMessages()]);
    }).catch((cause) => {
      loadPromise = null;
      warn(
        "[thread-outbox] failed to load persisted messages",
        new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause,
        }),
      );
    });
    return loadPromise;
  };

  const enqueue = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      try {
        await options.storage.write(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "enqueue",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        message,
      ]);
    });

  // Rewrites an already-queued message. A no-op when the message has been
  // removed in the meantime (e.g. deleted or delivered), so a trailing editor
  // flush can never resurrect it. Returns whether the message was updated.
  const update = (message: QueuedThreadMessage): Promise<boolean> =>
    serialize(async () => {
      const exists = currentMessages().some(
        (candidate) => candidate.messageId === message.messageId,
      );
      if (!exists) {
        return false;
      }
      try {
        await options.storage.write(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "update",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages([
        ...currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
        message,
      ]);
      return true;
    });

  // Moves a queued message one position within its own thread's queue. Like
  // `update` this is a no-op for a message that has since been delivered or
  // deleted, and for a move off either end. Returns whether anything moved.
  const reorder = (message: QueuedThreadMessage, move: QueuedThreadMessageMove): Promise<boolean> =>
    serialize(async () => {
      const queue = currentMessages().filter(
        (candidate) =>
          candidate.environmentId === message.environmentId &&
          candidate.threadId === message.threadId,
      );
      const changed = reorderQueuedThreadMessages(queue, message.messageId, move);
      if (changed.length === 0) {
        return false;
      }
      // Durable-write-first, as everywhere else here: the atom must never show
      // an order that is not on disk, or a reload would silently undo the move.
      // Written one at a time so a mid-way failure still leaves the atom
      // matching exactly what reached storage.
      const written: Array<QueuedThreadMessage> = [];
      try {
        for (const next of changed) {
          await options.storage.write(next);
          written.push(next);
        }
      } catch (cause) {
        if (written.length > 0) {
          setMessages([...currentMessages(), ...written]);
        }
        throw new ThreadOutboxManagerError({
          operation: "reorder",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      // groupQueuedThreadMessages dedupes by messageId keeping the last
      // occurrence, so appending the rewritten messages replaces them.
      setMessages([...currentMessages(), ...changed]);
      return true;
    });

  const remove = (message: QueuedThreadMessage): Promise<void> =>
    serialize(async () => {
      try {
        await options.storage.remove(message);
      } catch (cause) {
        throw new ThreadOutboxManagerError({
          operation: "remove",
          environmentId: message.environmentId,
          threadId: message.threadId,
          messageId: message.messageId,
          cause,
        });
      }
      setMessages(
        currentMessages().filter((candidate) => candidate.messageId !== message.messageId),
      );
    });

  // Discards every queued message for an environment, in memory and on disk.
  // Called when an environment is removed/forgotten so its queued messages can
  // never be resurrected (and silently delivered) if the same server — which
  // reuses the same server-issued environmentId — is later re-added. Mirrors
  // apps/mobile/src/state/thread-outbox-manager.ts clearEnvironment.
  const clearEnvironment = (environmentId: EnvironmentId): Promise<void> =>
    serialize(async () => {
      const persisted = await options.storage.load().catch((cause) => {
        warn(
          "[thread-outbox] failed to load messages while clearing environment",
          new ThreadOutboxManagerError({
            operation: "clear-environment-load",
            environmentId,
            threadId: null,
            messageId: null,
            cause,
          }),
        );
        return [];
      });
      const allMessages = flattenQueuedThreadMessages(
        groupQueuedThreadMessages([...persisted, ...currentMessages()]),
      );
      const removedMessageIds = new Set<MessageIdType>();

      await Promise.all(
        allMessages
          .filter((message) => message.environmentId === environmentId)
          .map(async (message) => {
            try {
              await options.storage.remove(message);
              removedMessageIds.add(message.messageId);
            } catch (cause) {
              warn(
                "[thread-outbox] failed to clear persisted message",
                new ThreadOutboxManagerError({
                  operation: "clear-environment-remove",
                  environmentId: message.environmentId,
                  threadId: message.threadId,
                  messageId: message.messageId,
                  cause,
                }),
              );
            }
          }),
      );

      setMessages(allMessages.filter((message) => !removedMessageIds.has(message.messageId)));
    });

  return {
    queuedMessagesByThreadKeyAtom,
    serialize,
    load,
    enqueue,
    update,
    reorder,
    remove,
    clearEnvironment,
  };
}

export type ThreadOutboxManager = ReturnType<typeof createThreadOutboxManager>;
