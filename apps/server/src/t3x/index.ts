/**
 * t3x — fork-local feature aggregator.
 *
 * Every fork-local server feature fans in here so that `apps/server/src/server.ts` needs
 * exactly ONE import and ONE `Layer.provideMerge(T3xLayerLive)` — no matter how many
 * features are added. This bounds the fork's conflict surface against upstream to a
 * single 2-line seam (see docs/t3x/SEAMS.md and the design specs under
 * docs/superpowers/specs/).
 *
 * To add a feature: build it under `apps/server/src/t3x/<feature>/`, then merge its
 * self-starting layer into `T3xLayerLive` below. Do NOT add a new edit to any
 * upstream-owned file.
 *
 * @module t3x
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { autoResumeRouteLayer } from "./autoResume/http.ts";
import { AutoResumeReactorLive } from "./autoResume/Reactor.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./autoResume/state.ts";
import { resolveConfig as resolveWebPushConfig } from "./webPush/config.ts";
import { webPushRouteLayer } from "./webPush/http.ts";
import { WebPushReactorLive } from "./webPush/Reactor.ts";
import { makePushSubscriptionStore, PushSubscriptionStore } from "./webPush/state.ts";
import { makeWebPushVapid, WebPushVapid } from "./webPush/vapid.ts";

const AUTO_RESUME_STATE_FILENAME = "t3x-auto-resume.json";
const WEB_PUSH_STATE_FILENAME = "t3x-web-push-subscriptions.json";

/** Wires the durable store to the server state directory. */
const AutoResumeStoreLive = Layer.effect(
  AutoResumeStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* makeAutoResumeStore(path.join(config.stateDir, AUTO_RESUME_STATE_FILENAME));
  }),
);

/** Web Push subscription store, wired to the server state directory. */
const PushSubscriptionStoreLive = Layer.effect(
  PushSubscriptionStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* makePushSubscriptionStore(path.join(config.stateDir, WEB_PUSH_STATE_FILENAME));
  }),
);

/** VAPID keypair (env override, else generated + persisted in the secret store). */
const WebPushVapidLive = Layer.effect(WebPushVapid, makeWebPushVapid(resolveWebPushConfig()));

/**
 * Shared fork-local deps for the Web Push reactor AND routes. Defined once at module scope so
 * both `T3xLayerLive` and `T3xRoutesLive` reference the SAME layer value — Effect memoises
 * construction by layer identity across the shared MemoMap, so the reactor and the subscribe
 * route mutate one store/keypair rather than racing two copies over a single file (the same
 * property `AutoResumeStoreLive` relies on above).
 */
const WebPushDepsLive = Layer.mergeAll(PushSubscriptionStoreLive, WebPushVapidLive);

/**
 * The single fork-local layer merged into the server. The auto-resume supervisor
 * self-starts on construction; its store is provided here so `server.ts` merges only
 * this one layer.
 */
export const T3xLayerLive = Layer.mergeAll(
  AutoResumeReactorLive.pipe(Layer.provide(AutoResumeStoreLive)),
  WebPushReactorLive.pipe(Layer.provide(WebPushDepsLive)),
);

/**
 * All fork-local HTTP routes, fanned in here for the same reason as `T3xLayerLive`:
 * `server.ts` adds ONE entry to its route list and imports it from this same module, so
 * adding future routes never grows the upstream seam.
 *
 * The store is `provide`d here rather than left as an open requirement. That matters for
 * two reasons:
 *
 *  1. **No seam leak.** An unsatisfied `AutoResumeStore` would surface in the type of
 *     upstream's `makeRoutesLayer` and fail every existing `server.test.ts` case — a fork
 *     change must never widen an upstream signature.
 *  2. **Still one instance.** Both this layer and `T3xLayerLive` provide the *same*
 *     module-level `AutoResumeStoreLive` value. Effect memoises layer construction per
 *     build keyed on layer identity, and `provideWith` / `mergeAllEffect` /
 *     `HttpRouter.serve` all thread the same `MemoMap`, so the reactor and the route share
 *     one store rather than racing two in-memory copies over a single file.
 *
 *     If that ever stopped holding, the route would mutate its own copy while the reactor
 *     read a stale one: switching auto-resume off in the UI would look like it worked and
 *     the thread would resume anyway. `autoResume/sharing.test.ts` pins the memoisation
 *     behaviour this relies on — note it exercises the composition *shape* with its own
 *     probes rather than importing these two layers, so treat it as a guard on the
 *     assumption, not proof of this file's graph.
 */
export const T3xRoutesLive = Layer.mergeAll(
  autoResumeRouteLayer.pipe(Layer.provide(AutoResumeStoreLive)),
  webPushRouteLayer.pipe(Layer.provide(WebPushDepsLive)),
);
