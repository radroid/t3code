/**
 * The process-level handle on the running supervisor's `LoopStore`.
 *
 * This exists for exactly one caller: `loopHooksFor`, which the Claude adapter yields while
 * building its query options. `Effect.serviceOption(LoopStore)` looked like it would be
 * enough — it reads the service optionally, so the adapter's requirements never widen — but
 * it resolves against the *fiber's* context, and in production that context is upstream's
 * layer graph. `CoilLayerLive` builds the store with `Layer.provide`, which discharges the
 * requirement rather than publishing it, so `LoopStore` is not in the app context, the
 * adapter reads `None`, and the hooks are never installed. The tests that pass do so because
 * they provide the store into the test fiber themselves.
 *
 * Publishing `LoopStore` out of `CoilLayerLive` instead would put a fork-only service in the
 * type of upstream's layer graph — the thing every seam decision in this fork exists to
 * avoid. So the supervisor installs itself here for the life of its scope, `loopHooksFor`
 * prefers the context when one is present (which keeps every existing test honest) and falls
 * back to this holder otherwise.
 *
 * A module-level mutable holder rather than a `Ref`: the reader is a synchronous SDK
 * callback path, there is exactly one supervisor per process, and the install/uninstall pair
 * is scoped so a torn-down layer cannot leave a stale store behind.
 *
 * @module coil/loop/hooksRegistry
 */

import * as Effect from "effect/Effect";

import type { LoopStoreShape } from "./state.ts";

let installedStore: LoopStoreShape | null = null;

/** The store the running supervisor installed, or `null` when no supervisor is up. */
export const installedLoopStore = (): LoopStoreShape | null => installedStore;

/**
 * Install for the life of the calling scope.
 *
 * The release only clears the holder when it still points at *this* store, so a layer torn
 * down after a second one was built cannot retire the live supervisor's hooks.
 */
export const installLoopStore = (store: LoopStoreShape) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      installedStore = store;
    }),
    () =>
      Effect.sync(() => {
        if (installedStore === store) installedStore = null;
      }),
  );
