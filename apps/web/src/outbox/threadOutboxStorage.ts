import type { MessageId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  parseQueuedThreadMessage,
  serializeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./threadOutbox.logic";

/**
 * localStorage-backed persistence for the thread outbox, mirroring the mobile
 * expo-file-system store (apps/mobile/src/state/thread-outbox-storage.ts) but
 * writing one localStorage key per queued message so a single corrupt entry is
 * skipped rather than dropping the whole queue ("skip invalid, never fatal").
 */

const THREAD_OUTBOX_KEY_PREFIX = "t3code:thread-outbox:v1:";

export class ThreadOutboxStorageError extends Schema.TaggedErrorClass<ThreadOutboxStorageError>()(
  "ThreadOutboxStorageError",
  {
    operation: Schema.Literals(["load", "read-message", "write", "remove"]),
    environmentId: Schema.NullOr(Schema.String),
    threadId: Schema.NullOr(Schema.String),
    messageId: Schema.NullOr(Schema.String),
    storageKey: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread outbox storage operation ${this.operation} failed for environment ${this.environmentId ?? "unknown"}, thread ${this.threadId ?? "unknown"}, message ${this.messageId ?? "unknown"}, key ${this.storageKey ?? "unknown"}.`;
  }
}

export interface ThreadOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<QueuedThreadMessage>>;
  readonly write: (message: QueuedThreadMessage) => Promise<void>;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
}

function storageKeyFor(messageId: MessageId): string {
  return `${THREAD_OUTBOX_KEY_PREFIX}${encodeURIComponent(messageId)}`;
}

function browserStorage(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

export const localThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    const storage = browserStorage();
    if (storage === null) {
      return [];
    }
    const messages: QueuedThreadMessage[] = [];
    let keys: string[];
    try {
      keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null && key.startsWith(THREAD_OUTBOX_KEY_PREFIX)) {
          keys.push(key);
        }
      }
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "load",
        environmentId: null,
        threadId: null,
        messageId: null,
        storageKey: null,
        cause,
      });
    }
    for (const key of keys) {
      try {
        const raw = storage.getItem(key);
        if (raw === null) {
          continue;
        }
        messages.push(parseQueuedThreadMessage(raw));
      } catch (cause) {
        console.warn(
          "[thread-outbox] ignored invalid persisted message",
          new ThreadOutboxStorageError({
            operation: "read-message",
            environmentId: null,
            threadId: null,
            messageId: null,
            storageKey: key,
            cause,
          }),
        );
      }
    }
    return messages;
  },
  write: async (message) => {
    const storage = browserStorage();
    if (storage === null) {
      return;
    }
    const key = storageKeyFor(message.messageId);
    try {
      storage.setItem(key, serializeQueuedThreadMessage(message));
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "write",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        storageKey: key,
        cause,
      });
    }
  },
  remove: async (message) => {
    const storage = browserStorage();
    if (storage === null) {
      return;
    }
    const key = storageKeyFor(message.messageId);
    try {
      storage.removeItem(key);
    } catch (cause) {
      throw new ThreadOutboxStorageError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        storageKey: key,
        cause,
      });
    }
  },
};
