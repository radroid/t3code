/**
 * IPC surface for the fork's update delivery.
 *
 * A fork-owned file under an upstream directory, mirroring `notifications.ts`. The only upstream
 * edits it needs are the four channel constants and the three `ipc.handle` registrations — see
 * `docs/coil/SEAMS.md`.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CoilUpdateDelivery from "../../coil/updateDelivery/UpdateDelivery.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Mirrors CoilUpdateState from @t3tools/contracts. Encoded rather than passed through, so a shape
// change on either side fails here rather than reaching the renderer as `undefined`.
const UpdateStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("staging"), shortSha: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("ready"),
    shortSha: Schema.String,
    version: Schema.String,
    // Optional because the manifest's are: a build published before these fields existed still
    // has to reach the renderer. A required field here would fail the encode and the toast would
    // never appear — withholding a real update, which is the failure this feature exists to fix.
    changes: Schema.optionalKey(Schema.Array(Schema.String)),
    builtAt: Schema.optionalKey(Schema.String),
    runUrl: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("restarting") }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.String,
    logPath: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("updated"),
    shortSha: Schema.String,
    version: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("install-failed"),
    expectedShortSha: Schema.String,
    expectedVersion: Schema.String,
    // Optional for the same reason as the `ready` fields: a build with no embedded commit hash
    // still has to reach the renderer, and that case is precisely one worth reporting.
    actualShortSha: Schema.optionalKey(Schema.String),
    actualVersion: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
]);

const UpdateState = Schema.Struct({
  status: UpdateStatus,
  hasUpdatedBefore: Schema.Boolean,
});

export const getCoilUpdateState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COIL_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: UpdateState,
  handler: Effect.fn("desktop.ipc.coilUpdate.getState")(function* () {
    const delivery = yield* CoilUpdateDelivery.CoilUpdateDelivery;
    return yield* delivery.state;
  }),
});

export const restartIntoUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COIL_UPDATE_RESTART_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.coilUpdate.restart")(function* () {
    const delivery = yield* CoilUpdateDelivery.CoilUpdateDelivery;
    yield* delivery.restartNow;
  }),
});

export const dismissCoilUpdate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COIL_UPDATE_DISMISS_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.coilUpdate.dismiss")(function* (shortSha) {
    const delivery = yield* CoilUpdateDelivery.CoilUpdateDelivery;
    yield* delivery.dismiss(shortSha);
  }),
});
