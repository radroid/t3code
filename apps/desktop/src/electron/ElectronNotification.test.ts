import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

interface FakeNotificationEntry {
  readonly options: { readonly title?: string; readonly body?: string };
  readonly listeners: Map<string, (...args: readonly unknown[]) => void>;
  shown: number;
}

const { notificationState, FakeNotification } = vi.hoisted(() => {
  const notificationState = {
    supported: true,
    constructorThrows: null as Error | null,
    instances: [] as FakeNotificationEntry[],
  };

  class FakeNotification {
    static isSupported(): boolean {
      return notificationState.supported;
    }

    readonly entry: FakeNotificationEntry;

    constructor(options: { title?: string; body?: string }) {
      if (notificationState.constructorThrows !== null) {
        throw notificationState.constructorThrows;
      }
      this.entry = { options, listeners: new Map(), shown: 0 };
      notificationState.instances.push(this.entry);
    }

    on(event: string, listener: (...args: readonly unknown[]) => void): this {
      this.entry.listeners.set(event, listener);
      return this;
    }

    show(): void {
      this.entry.shown += 1;
    }
  }

  return { notificationState, FakeNotification };
});

vi.mock("electron", () => ({ Notification: FakeNotification }));

import { NOTIFICATION_ACTIVATED_CHANNEL } from "../ipc/channels.ts";
import * as ElectronNotification from "./ElectronNotification.ts";
import * as ElectronWindow from "./ElectronWindow.ts";

const request = {
  id: "thread-1",
  title: "T3 Code needs your input",
  body: "Claude is waiting on your answer.",
  environmentId: "local",
  threadId: "thread-1",
} as const;

const clickFirstNotification = () => {
  const entry = notificationState.instances[0];
  assert.isDefined(entry);
  const click = entry.listeners.get("click");
  if (click === undefined) {
    throw new Error("Expected the notification to register a click listener.");
  }
  click();
};

describe("ElectronNotification", () => {
  beforeEach(() => {
    notificationState.supported = true;
    notificationState.constructorThrows = null;
    notificationState.instances = [];
  });

  it.effect("shows a native notification carrying the request title and body", () =>
    Effect.gen(function* () {
      const notifications = yield* ElectronNotification.ElectronNotification;
      yield* notifications.show(request);

      assert.equal(notificationState.instances.length, 1);
      assert.deepEqual(notificationState.instances[0]?.options, {
        title: "T3 Code needs your input",
        body: "Claude is waiting on your answer.",
      });
      assert.equal(notificationState.instances[0]?.shown, 1);
    }).pipe(
      Effect.provide(
        ElectronNotification.layer.pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("reveals the target window and broadcasts the activation on click", () =>
    Effect.gen(function* () {
      const window = { id: 7 } as Electron.BrowserWindow;
      const revealedRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const sent = yield* Deferred.make<readonly unknown[]>();
      const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeed(Option.some(window)),
        reveal: (target) => Ref.set(revealedRef, Option.some(target)),
        sendAll: (channel, ...args) =>
          Deferred.succeed(sent, [channel, ...args]).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const notifications = yield* ElectronNotification.ElectronNotification;
        yield* notifications.show(request);

        clickFirstNotification();

        const broadcast = yield* Deferred.await(sent);
        assert.deepEqual(broadcast, [
          NOTIFICATION_ACTIVATED_CHANNEL,
          { environmentId: "local", threadId: "thread-1" },
        ]);
        assert.strictEqual(Option.getOrNull(yield* Ref.get(revealedRef)), window);
      }).pipe(Effect.provide(ElectronNotification.layer.pipe(Layer.provide(windowLayer))));
    }),
  );

  it.effect("broadcasts the activation even when there is no window to reveal", () =>
    Effect.gen(function* () {
      const sent = yield* Deferred.make<readonly unknown[]>();
      const windowLayer = Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeed(Option.none()),
        sendAll: (channel, ...args) =>
          Deferred.succeed(sent, [channel, ...args]).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const notifications = yield* ElectronNotification.ElectronNotification;
        yield* notifications.show(request);

        clickFirstNotification();

        assert.deepEqual(yield* Deferred.await(sent), [
          NOTIFICATION_ACTIVATED_CHANNEL,
          { environmentId: "local", threadId: "thread-1" },
        ]);
      }).pipe(Effect.provide(ElectronNotification.layer.pipe(Layer.provide(windowLayer))));
    }),
  );

  it.effect("no-ops when the platform does not support native notifications", () =>
    Effect.gen(function* () {
      notificationState.supported = false;

      const notifications = yield* ElectronNotification.ElectronNotification;
      yield* notifications.show(request);

      assert.equal(notificationState.instances.length, 0);
    }).pipe(
      Effect.provide(
        ElectronNotification.layer.pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("swallows Electron notification failures instead of failing the caller", () =>
    Effect.gen(function* () {
      notificationState.constructorThrows = new Error("notification center unavailable");

      const notifications = yield* ElectronNotification.ElectronNotification;
      const exit = yield* Effect.exit(notifications.show(request));

      assert.equal(exit._tag, "Success");
      assert.equal(notificationState.instances.length, 0);
    }).pipe(
      Effect.provide(
        ElectronNotification.layer.pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      ),
    ),
  );
});
