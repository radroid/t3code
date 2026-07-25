import type { DesktopNotificationActivation, DesktopNotificationRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { NOTIFICATION_ACTIVATED_CHANNEL } from "../ipc/channels.ts";
import * as ElectronWindow from "./ElectronWindow.ts";

export class ElectronNotificationShowError extends Schema.TaggedErrorClass<ElectronNotificationShowError>()(
  "ElectronNotificationShowError",
  {
    notificationId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to show the Electron notification ${JSON.stringify(this.notificationId)}.`;
  }
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /**
     * Raises a native OS notification. Resolves once the notification has been
     * handed to the platform, and no-ops when the platform has no notification
     * support. Clicking the notification reveals the current window and
     * broadcasts a `DesktopNotificationActivation` to every renderer.
     */
    readonly show: (request: DesktopNotificationRequest) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

export const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  // The click listener is a bare Electron callback, so the activation effect
  // has to be run against the captured context (keeps logging/tracing intact).
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  // Live notifications keyed by `DesktopNotificationRequest.id`, which the
  // contract defines as a coalescing key: showing again for the same id
  // replaces the previous entry instead of stacking a second one in
  // Notification Center (the web path gets this from the notification `tag`).
  // Holding the JS reference also keeps the notification from being collected
  // while it is on screen, which is what makes Electron's `click` reliable.
  const liveNotifications = new Map<string, Electron.Notification>();

  const activate = Effect.fn("desktop.electron.notification.activate")(function* (
    request: DesktopNotificationRequest,
  ) {
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isSome(window)) {
      yield* electronWindow.reveal(window.value);
    }

    const activation: DesktopNotificationActivation = {
      environmentId: request.environmentId,
      threadId: request.threadId,
    };
    // Broadcast rather than target the revealed window: any renderer may own
    // the thread, and the activation is idempotent for the ones that don't.
    yield* electronWindow.sendAll(NOTIFICATION_ACTIVATED_CHANNEL, activation);
  });

  const show = Effect.fn("desktop.electron.notification.show")(function* (
    request: DesktopNotificationRequest,
  ) {
    const supported = yield* Effect.try({
      try: () => Electron.Notification.isSupported(),
      catch: (cause) => new ElectronNotificationShowError({ notificationId: request.id, cause }),
    });
    if (!supported) {
      return;
    }

    yield* Effect.try({
      try: () => {
        const notification = new Electron.Notification({
          title: request.title,
          body: request.body,
        });
        const forget = () => {
          if (liveNotifications.get(request.id) === notification) {
            liveNotifications.delete(request.id);
          }
        };
        notification.on("click", () => {
          forget();
          runFork(activate(request));
        });
        notification.on("close", forget);

        liveNotifications.get(request.id)?.close();
        liveNotifications.set(request.id, notification);
        notification.show();
      },
      catch: (cause) => new ElectronNotificationShowError({ notificationId: request.id, cause }),
    });
  });

  return ElectronNotification.of({
    // Notifications are advisory: failing to raise one must never fail the
    // renderer's invoke, so failures are logged and swallowed here.
    show: (request) => show(request).pipe(Effect.catch((error) => Effect.logWarning(error))),
  });
});

export const layer = Layer.effect(ElectronNotification, make);
