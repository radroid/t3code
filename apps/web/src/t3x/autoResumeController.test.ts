import { describe, expect, it } from "vite-plus/test";

import type { AutoResumeClient, AutoResumeState, AutoResumeWrite } from "./autoResumeClient";
import {
  type AutoResumeTimers,
  createAutoResumeController,
} from "./autoResumeController";

const ENABLED: AutoResumeState = { enabled: true, overridePrompt: null, pending: null };
const DISABLED: AutoResumeState = { enabled: false, overridePrompt: null, pending: null };

/** Manually-settled promises, so each test decides exactly when the network resolves. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeClient extends AutoResumeClient {
  readonly reads: string[];
  readonly writes: AutoResumeWrite[];
  readonly pendingReads: Deferred<AutoResumeState | null>[];
  readonly pendingWrites: Deferred<AutoResumeState | null>[];
  /** Makes the next `write` call throw synchronously, like a bad URL would. */
  throwOnNextWrite: boolean;
}

function createFakeClient(): FakeClient {
  const client: FakeClient = {
    reads: [],
    writes: [],
    pendingReads: [],
    pendingWrites: [],
    throwOnNextWrite: false,
    read: (threadId) => {
      client.reads.push(threadId);
      const entry = deferred<AutoResumeState | null>();
      client.pendingReads.push(entry);
      return entry.promise;
    },
    write: (body) => {
      if (client.throwOnNextWrite) {
        client.throwOnNextWrite = false;
        throw new Error("synchronous failure building the request");
      }
      client.writes.push(body);
      const entry = deferred<AutoResumeState | null>();
      client.pendingWrites.push(entry);
      return entry.promise;
    },
  };
  return client;
}

interface FakeTimers extends AutoResumeTimers {
  /** Runs every scheduled-and-not-cleared callback. */
  readonly flush: () => void;
  readonly scheduledCount: () => number;
}

function createFakeTimers(): FakeTimers {
  const scheduled = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    setTimeout: (handler) => {
      const handle = nextHandle++;
      scheduled.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle) => {
      scheduled.delete(handle);
    },
    flush: () => {
      const entries = [...scheduled.values()];
      scheduled.clear();
      for (const handler of entries) {
        handler();
      }
    },
    scheduledCount: () => scheduled.size,
  };
}

function setup() {
  const client = createFakeClient();
  const timers = createFakeTimers();
  const controller = createAutoResumeController({ client, timers, promptDebounceMs: 600 });
  return { client, timers, controller };
}

/** Lets every already-resolved promise callback run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createAutoResumeController", () => {
  it("loads the thread on setThread and exposes the result", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    expect(client.reads).toEqual(["thread-a"]);

    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    expect(controller.getSnapshot().state).toEqual(ENABLED);
  });

  it("returns a referentially stable snapshot so useSyncExternalStore cannot loop", async () => {
    const { client, controller } = setup();

    const before = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(before);

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    const after = controller.getSnapshot();
    expect(after).not.toBe(before);
    // A second read with no intervening change must hand back the same object.
    expect(controller.getSnapshot()).toBe(after);
  });

  it("seeds the prompt draft from the server but never overwrites what the user typed", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve({ ...ENABLED, overridePrompt: "keep going" });
    await settle();
    expect(controller.getSnapshot().promptDraft).toBe("keep going");

    controller.setPromptDraft("my own text");
    controller.refresh();
    client.pendingReads[1]?.resolve({ ...ENABLED, overridePrompt: "keep going" });
    await settle();

    expect(controller.getSnapshot().promptDraft).toBe("my own text");
  });

  it("skips polling while a write is in flight so it cannot stomp an optimistic value", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    controller.setEnabled(true);
    expect(controller.getSnapshot().state?.enabled).toBe(true);

    const readsBefore = client.reads.length;
    controller.refresh();
    expect(client.reads.length).toBe(readsBefore);

    // Once the write lands, polling resumes.
    client.pendingWrites[0]?.resolve(ENABLED);
    await settle();
    controller.refresh();
    expect(client.reads.length).toBe(readsBefore + 1);
  });

  it("rolls back an optimistic toggle when the write fails", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    controller.setEnabled(true);
    expect(controller.getSnapshot().state?.enabled).toBe(true);

    client.pendingWrites[0]?.resolve(null);
    await settle();

    expect(controller.getSnapshot().state?.enabled).toBe(false);
  });

  it("releases the in-flight counter when a write rejects", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    controller.setEnabled(true);
    client.pendingWrites[0]?.reject(new Error("network died"));
    await settle();

    const readsBefore = client.reads.length;
    controller.refresh();
    expect(client.reads.length).toBe(readsBefore + 1);
  });

  it("releases the in-flight counter when a write throws synchronously", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    // A leaked increment here would freeze polling for the life of the controller.
    client.throwOnNextWrite = true;
    controller.setEnabled(true);
    await settle();

    const readsBefore = client.reads.length;
    controller.refresh();
    expect(client.reads.length).toBe(readsBefore + 1);
  });

  it("discards a write result for a thread the user already navigated away from", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    controller.setEnabled(true);
    controller.setThread("thread-b");
    client.pendingReads[1]?.resolve(ENABLED);
    await settle();

    // The thread-a write lands late and must be ignored.
    client.pendingWrites[0]?.resolve({ ...DISABLED, overridePrompt: "stale" });
    await settle();

    expect(controller.getSnapshot().state).toEqual(ENABLED);
  });

  it("loads a newly selected thread even while the previous thread's write is in flight", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(DISABLED);
    await settle();

    // Leave a write outstanding on thread-a, then switch. A globally-scoped in-flight gate
    // swallowed thread-b's initial load here, leaving the overlay blank until the next poll.
    controller.setEnabled(true);
    controller.setThread("thread-b");

    expect(client.reads).toEqual(["thread-a", "thread-b"]);
    client.pendingReads[1]?.resolve(ENABLED);
    await settle();
    expect(controller.getSnapshot().state).toEqual(ENABLED);
  });

  it("discards a read that resolves after the thread changed", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    controller.setThread("thread-b");

    client.pendingReads[1]?.resolve(ENABLED);
    client.pendingReads[0]?.resolve({ ...DISABLED, overridePrompt: "from thread a" });
    await settle();

    expect(controller.getSnapshot().state).toEqual(ENABLED);
  });

  it("coalesces rapid prompt edits into a single debounced write", async () => {
    const { client, timers, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.setPromptDraft("c");
    controller.setPromptDraft("co");
    controller.setPromptDraft("con");
    expect(client.writes).toHaveLength(0);
    expect(timers.scheduledCount()).toBe(1);

    timers.flush();
    expect(client.writes).toEqual([{ threadId: "thread-a", overridePrompt: "con" }]);
  });

  it("normalises a whitespace-only prompt to null", async () => {
    const { client, timers, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.setPromptDraft("   ");
    timers.flush();

    expect(client.writes).toEqual([{ threadId: "thread-a", overridePrompt: null }]);
  });

  it("flushes a debounced edit under the originating threadId when the thread changes", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.setPromptDraft("half-typed");
    // Switching threads inside the debounce window used to drop this edit silently.
    controller.setThread("thread-b");

    expect(client.writes).toEqual([{ threadId: "thread-a", overridePrompt: "half-typed" }]);
  });

  it("flushes a debounced edit on dispose", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.setPromptDraft("unsaved");
    controller.dispose();

    expect(client.writes).toEqual([{ threadId: "thread-a", overridePrompt: "unsaved" }]);
  });

  it("does not write again when the debounce timer already fired", async () => {
    const { client, timers, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.setPromptDraft("saved");
    timers.flush();
    expect(client.writes).toHaveLength(1);

    controller.dispose();
    expect(client.writes).toHaveLength(1);
  });

  it("resets state when the thread changes so the previous thread never flashes", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();
    expect(controller.getSnapshot().state).toEqual(ENABLED);

    controller.setThread("thread-b");
    expect(controller.getSnapshot().state).toBeNull();
    expect(controller.getSnapshot().promptDraft).toBe("");
  });

  it("keeps the overlay hidden when the server is unreachable", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(null);
    await settle();

    expect(controller.getSnapshot().state).toBeNull();
  });

  it("notifies subscribers on change and stops after unsubscribe", async () => {
    const { client, controller } = setup();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();
    expect(notifications).toBeGreaterThan(0);

    const seen = notifications;
    unsubscribe();
    controller.setThread("thread-b");
    expect(notifications).toBe(seen);
  });

  it("ignores mutations after dispose", async () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    client.pendingReads[0]?.resolve(ENABLED);
    await settle();

    controller.dispose();
    const writesAfterDispose = client.writes.length;
    controller.setEnabled(false);
    controller.setPromptDraft("late");
    controller.refresh();

    expect(client.writes).toHaveLength(writesAfterDispose);
    expect(controller.getSnapshot().state).toEqual(ENABLED);
  });

  it("does nothing when toggled before the first load lands", () => {
    const { client, controller } = setup();

    controller.setThread("thread-a");
    controller.setEnabled(true);

    expect(client.writes).toHaveLength(0);
  });
});
