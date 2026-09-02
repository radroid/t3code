import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  modelSelectionsEqual,
  parseQueuedThreadMessage,
  reorderQueuedThreadMessages,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  serializeQueuedThreadMessage,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
  isThreadIdleForOutboxDrain,
} from "./threadOutbox.logic";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./threadOutboxManager";
import type { ThreadOutboxStorage } from "./threadOutboxStorage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly sortKey?: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    createdAt: input.createdAt,
    ...(input.sortKey !== undefined ? { sortKey: input.sortKey } : {}),
  };
}

/** The queued message ids for a single thread, in delivery order. */
function orderedIds(queue: ReadonlyArray<QueuedThreadMessage>): ReadonlyArray<string> {
  const grouped = groupQueuedThreadMessages(queue);
  return (Object.values(grouped)[0] ?? []).map((message) => message.messageId);
}

/** Applies the messages a reorder rewrote back onto the queue they came from. */
function applyReorder(
  queue: ReadonlyArray<QueuedThreadMessage>,
  changed: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<QueuedThreadMessage> {
  return [...queue, ...changed];
}

describe("thread outbox model", () => {
  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("dedupes by message id, keeping the last occurrence", () => {
    const first = queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" });
    const replacement = { ...first, text: "edited" };

    expect(groupQueuedThreadMessages([first, replacement])).toEqual({
      "environment-1:thread-1": [replacement],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(decodeQueuedThreadMessage({ schemaVersion: 1, ...message })).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({ schemaVersion: 1, environmentId: "environment-1" }),
    ).toThrow();
  });

  it("round-trips a message with a settings snapshot through the JSON store form", () => {
    const selectedMessage = {
      ...queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" }),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(parseQueuedThreadMessage(serializeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
  });

  it("falls back to the thread settings for fields the queued message omits", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const threadSettings = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } as const;

    expect(resolveQueuedThreadSettings(legacyMessage, threadSettings)).toEqual(threadSettings);
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, { ...base, options: [{ id: "reasoningEffort", value: "xhigh" }] }),
    ).toBe(false);
    expect(modelSelectionsEqual(base, { ...base, model: "gpt-5.5" })).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
  });

  it("sends only when connected and the thread is idle", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
        threadBusy: false,
      }),
    ).toBe("wait");
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings sync fails but discards deterministic start-turn failures", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("discard");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: true,
      }),
    ).toBe("retry");
  });

  it("orders by an explicit sort key once one is present, then by message id", () => {
    // A message reordered to the front sorts ahead of an older one despite its
    // later createdAt.
    const first = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
      sortKey: "2026-06-08T10:00:01.000Z",
    });
    const second = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
      sortKey: "2026-06-08T10:00:02.000Z",
    });

    expect(orderedIds([second, first])).toEqual(["message-2", "message-1"]);

    // Same instant, no sort key: the message id breaks the tie, so the order
    // cannot depend on localStorage key-enumeration order across a reload.
    const sameInstantB = queuedMessage({
      messageId: "message-b",
      createdAt: "2026-06-08T10:00:03.000Z",
    });
    const sameInstantA = queuedMessage({
      messageId: "message-a",
      createdAt: "2026-06-08T10:00:03.000Z",
    });

    expect(orderedIds([sameInstantB, sameInstantA])).toEqual(["message-a", "message-b"]);
    expect(orderedIds([sameInstantA, sameInstantB])).toEqual(["message-a", "message-b"]);
  });

  it("moves a queued message one position and rewrites only what changed", () => {
    const queue = [
      queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" }),
      queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" }),
      queuedMessage({ messageId: "message-3", createdAt: "2026-06-08T10:00:03.000Z" }),
    ];

    const down = reorderQueuedThreadMessages(queue, MessageId.make("message-1"), "down");
    expect(down.map((message) => message.messageId)).toEqual(["message-2", "message-1"]);
    expect(orderedIds(applyReorder(queue, down))).toEqual(["message-2", "message-1", "message-3"]);

    const up = reorderQueuedThreadMessages(queue, MessageId.make("message-3"), "up");
    expect(orderedIds(applyReorder(queue, up))).toEqual(["message-1", "message-3", "message-2"]);

    // createdAt is the message's permanent timestamp in thread history, so a
    // reorder must never rewrite it.
    for (const message of [...down, ...up]) {
      const original = queue.find((candidate) => candidate.messageId === message.messageId);
      expect(message.createdAt).toBe(original?.createdAt);
    }
  });

  it("treats a move off either end, or of an unknown message, as a no-op", () => {
    const queue = [
      queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" }),
      queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" }),
    ];

    expect(reorderQueuedThreadMessages(queue, MessageId.make("message-1"), "up")).toEqual([]);
    expect(reorderQueuedThreadMessages(queue, MessageId.make("message-2"), "down")).toEqual([]);
    expect(reorderQueuedThreadMessages(queue, MessageId.make("message-9"), "up")).toEqual([]);
    expect(reorderQueuedThreadMessages([], MessageId.make("message-1"), "down")).toEqual([]);
  });

  it("swaps two messages queued in the same millisecond", () => {
    // Both carry identical order keys, so without disambiguation the message-id
    // tiebreak would silently undo the move.
    const queue = [
      queuedMessage({ messageId: "message-a", createdAt: "2026-06-08T10:00:01.000Z" }),
      queuedMessage({ messageId: "message-b", createdAt: "2026-06-08T10:00:01.000Z" }),
    ];

    const changed = reorderQueuedThreadMessages(queue, MessageId.make("message-b"), "up");
    expect(orderedIds(applyReorder(queue, changed))).toEqual(["message-b", "message-a"]);
  });

  it("keeps a reordered message ahead of one queued afterwards", () => {
    // Reordering re-deals the queue's existing slots rather than inventing new
    // keys, so a later enqueue still lands at the back.
    const queue = [
      queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" }),
      queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" }),
    ];
    const changed = reorderQueuedThreadMessages(queue, MessageId.make("message-2"), "up");
    const later = queuedMessage({
      messageId: "message-3",
      createdAt: "2026-06-08T10:00:09.000Z",
    });

    expect(orderedIds([...applyReorder(queue, changed), later])).toEqual([
      "message-2",
      "message-1",
      "message-3",
    ]);
  });
});

describe("thread outbox manager", () => {
  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("clears queued messages for a removed environment, including persisted-only zombies", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    // A message that survived a prior reload only on disk (never re-loaded into
    // the atom) — the exact "zombie" that must not resurrect on reconnect.
    const persistedZombie = queuedMessage({
      messageId: "message-0",
      createdAt: "2026-06-08T10:00:00.000Z",
    });
    stored.set(persistedZombie.messageId, persistedZombie);

    const doomed = queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" });
    const survivor = queuedMessage({
      environmentId: "environment-2",
      threadId: "thread-2",
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });

    await manager.enqueue(doomed);
    await manager.enqueue(survivor);

    await manager.clearEnvironment(EnvironmentId.make("environment-1"));

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-2:thread-2": [survivor],
    });
    expect([...stored.values()]).toEqual([survivor]);
    registry.dispose();
  });

  it("reorders a thread's queue durably and leaves other threads alone", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const first = queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" });
    const second = queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" });
    const otherThread = queuedMessage({
      threadId: "thread-2",
      messageId: "message-3",
      createdAt: "2026-06-08T10:00:03.000Z",
    });
    await manager.enqueue(first);
    await manager.enqueue(second);
    await manager.enqueue(otherThread);

    await expect(manager.reorder(second, "up")).resolves.toBe(true);

    const queues = registry.get(manager.queuedMessagesByThreadKeyAtom);
    expect(queues["environment-1:thread-1"]?.map((message) => message.messageId)).toEqual([
      "message-2",
      "message-1",
    ]);
    expect(queues["environment-1:thread-2"]).toEqual([otherThread]);
    // The move must survive a reload, so it has to be on disk — not just in the
    // atom.
    expect(
      groupQueuedThreadMessages([...stored.values()])["environment-1:thread-1"]?.map(
        (message) => message.messageId,
      ),
    ).toEqual(["message-2", "message-1"]);

    // Already at the head: nothing to write, nothing to report.
    await expect(manager.reorder(second, "up")).resolves.toBe(false);
    // Delivered or deleted in the meantime: a trailing reorder is a no-op and
    // must not resurrect it.
    await manager.remove(second);
    await expect(manager.reorder(second, "down")).resolves.toBe(false);
    expect(stored.has(second.messageId)).toBe(false);
    registry.dispose();
  });

  it("keeps the atom aligned with disk when a reorder write fails part way", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const writeCause = new Error("write failed");
    let failWritesFor: string | null = null;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        if (message.messageId === failWritesFor) {
          throw writeCause;
        }
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const first = queuedMessage({ messageId: "message-1", createdAt: "2026-06-08T10:00:01.000Z" });
    const second = queuedMessage({ messageId: "message-2", createdAt: "2026-06-08T10:00:02.000Z" });
    await manager.enqueue(first);
    await manager.enqueue(second);

    // reorder writes message-2 then message-1; fail the second write.
    failWritesFor = "message-1";
    await expect(manager.reorder(second, "up")).rejects.toThrow(ThreadOutboxManagerError);

    // Whatever the atom shows must be exactly what a reload would rebuild.
    const atomQueues = registry.get(manager.queuedMessagesByThreadKeyAtom);
    const diskQueues = groupQueuedThreadMessages([...stored.values()]);
    const messageIds = (queue: ReadonlyArray<QueuedThreadMessage> | undefined) =>
      queue?.map((message) => message.messageId);
    expect(messageIds(atomQueues["environment-1:thread-1"])).toEqual(
      messageIds(diskQueues["environment-1:thread-1"]),
    );
    registry.dispose();
  });
});

describe("isThreadIdleForOutboxDrain", () => {
  // Upstream #8600 deleted client-runtime's `canSettle`, which this replaces.
  // The regression it guards is a queued head dispatching on top of a live
  // turn, which the surviving `canSnooze` would have allowed.
  const NOW = "2026-09-02T12:00:00.000Z";
  type OutboxIdleShell = Parameters<typeof isThreadIdleForOutboxDrain>[0];
  type OutboxIdleSession = NonNullable<OutboxIdleShell["session"]>;

  const idle: OutboxIdleShell = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestUserMessageAt: null,
    latestTurn: null,
  };

  // Spelled out rather than cast so that a field upstream adds to the session
  // breaks this file instead of being silently absorbed.
  const sessionWith = (status: OutboxIdleSession["status"]): OutboxIdleSession => ({
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: null,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: null,
    updatedAt: IsoDateTime.make("2026-09-02T11:59:00.000Z"),
  });

  it("dispatches into a thread with no live session and nothing pending", () => {
    expect(isThreadIdleForOutboxDrain(idle, { now: NOW })).toBe(true);
  });

  it.each(["starting", "running"] as const)("holds while the session is %s", (status) => {
    expect(
      isThreadIdleForOutboxDrain({ ...idle, session: sessionWith(status) }, { now: NOW }),
    ).toBe(false);
  });

  it("dispatches once a previous session has gone idle", () => {
    expect(
      isThreadIdleForOutboxDrain({ ...idle, session: sessionWith("idle") }, { now: NOW }),
    ).toBe(true);
  });

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "holds while the agent is blocked on the user (%s)",
    (blocker) => {
      expect(isThreadIdleForOutboxDrain({ ...idle, [blocker]: true }, { now: NOW })).toBe(false);
    },
  );

  it("holds for a user message no turn has adopted yet", () => {
    // Inside the adoption grace window with no turn to match it: pending work
    // that session status cannot see.
    expect(
      isThreadIdleForOutboxDrain(
        { ...idle, latestUserMessageAt: IsoDateTime.make("2026-09-02T11:59:30.000Z") },
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("dispatches once the unadopted message ages past the grace window", () => {
    expect(
      isThreadIdleForOutboxDrain(
        { ...idle, latestUserMessageAt: IsoDateTime.make("2026-09-02T11:50:00.000Z") },
        { now: NOW },
      ),
    ).toBe(true);
  });
});
