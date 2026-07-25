import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AttentionEvent } from "./needsAttention.logic";
import { showAttentionNotification } from "./notifier";

const event: AttentionEvent = {
  key: "local::thread-1",
  kind: "waiting_for_input",
  environmentId: "local",
  threadId: "thread-1",
  title: "T3 Code needs your input",
  body: "Claude is waiting on your answer.",
};

interface ConstructedNotification {
  readonly title: string;
  readonly options: NotificationOptions | undefined;
}

/**
 * The unit project runs on `node`, so both `window` and the `Notification`
 * constructor the shim reaches for as a free variable have to be stubbed.
 */
function stubWebNotification(constructor: unknown): void {
  vi.stubGlobal("window", { Notification: constructor, focus: vi.fn() });
  vi.stubGlobal("Notification", constructor);
}

describe("showAttentionNotification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes through the desktop bridge and never touches the web API", () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const webConstructor = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { showNotification }, Notification: webConstructor });
    vi.stubGlobal("Notification", webConstructor);

    showAttentionNotification(event, () => undefined);

    expect(showNotification).toHaveBeenCalledWith({
      id: "local::thread-1",
      title: "T3 Code needs your input",
      body: "Claude is waiting on your answer.",
      environmentId: "local",
      threadId: "thread-1",
    });
    expect(webConstructor).not.toHaveBeenCalled();
  });

  it("falls back to a web notification tagged with the event key", () => {
    const constructed: ConstructedNotification[] = [];
    class FakeNotification {
      constructor(title: string, options?: NotificationOptions) {
        constructed.push({ title, options });
      }
      addEventListener(): void {}
      close(): void {}
    }
    stubWebNotification(FakeNotification);

    showAttentionNotification(event, () => undefined);

    expect(constructed).toEqual([
      {
        title: "T3 Code needs your input",
        options: { body: "Claude is waiting on your answer.", tag: "local::thread-1" },
      },
    ]);
  });

  it("stays silent when the constructor throws, as it does on Android Chrome", () => {
    const webConstructor = vi.fn(() => {
      throw new TypeError("Illegal constructor");
    });
    stubWebNotification(webConstructor);

    expect(() => showAttentionNotification(event, () => undefined)).not.toThrow();
    expect(webConstructor).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the platform has no Notification API at all", () => {
    vi.stubGlobal("window", {});

    expect(() => showAttentionNotification(event, () => undefined)).not.toThrow();
  });
});
