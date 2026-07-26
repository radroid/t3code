import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronNotification from "../../electron/ElectronNotification.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Mirrors DesktopNotificationRequest from @t3tools/contracts; the handler's
// call into ElectronNotification.show keeps the two structurally checked.
const NotificationRequestInput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.String,
});

export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_NOTIFICATION_CHANNEL,
  payload: NotificationRequestInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.showNotification")(function* (request) {
    const notifications = yield* ElectronNotification.ElectronNotification;
    yield* notifications.show(request);
  }),
});
