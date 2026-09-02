/**
 * Fork-owned raw HTTP routes backing Web Push subscription management.
 *
 *   GET  /api/coil/push/vapid-public-key  -> { publicKey }        (read scope)
 *   POST /api/coil/push/subscribe         -> { ok: true }         (operate scope)
 *   POST /api/coil/push/unsubscribe       -> { ok: true }         (operate scope)
 *
 * Raw routes, not WS-RPC: an RPC would force edits to `@t3tools/contracts` + `ws.ts` + its
 * scope map. These mount via `CoilRoutesLive` in coil/index.ts, so server.ts is untouched.
 * Auth is the shared `coil/http/auth.ts` mirror, not a local paste. See docs/coil/SEAMS.md.
 *
 * @module coil/webPush/http
 */

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticateWithScope, routeAuthErrorTags } from "../http/auth.ts";
import { PushSubscriptionStore, type PushSubscriptionStoreShape } from "./state.ts";
import { WebPushVapid, type WebPushVapidKeys } from "./vapid.ts";

export const VAPID_KEY_ROUTE_PATH = "/api/coil/push/vapid-public-key";
export const SUBSCRIBE_ROUTE_PATH = "/api/coil/push/subscribe";
export const UNSUBSCRIBE_ROUTE_PATH = "/api/coil/push/unsubscribe";

const SubscribeBody = Schema.Struct({
  endpoint: Schema.String,
  keys: Schema.Struct({
    p256dh: Schema.String,
    auth: Schema.String,
  }),
});
const decodeSubscribeBody = Schema.decodeUnknownEffect(SubscribeBody);

const UnsubscribeBody = Schema.Struct({
  endpoint: Schema.String,
});
const decodeUnsubscribeBody = Schema.decodeUnknownEffect(UnsubscribeBody);

const makeVapidKeyRoute = (vapid: WebPushVapidKeys) =>
  HttpRouter.add(
    "GET",
    VAPID_KEY_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticateWithScope(AuthOrchestrationReadScope);
      return HttpServerResponse.jsonUnsafe({ publicKey: vapid.publicKey });
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makeSubscribeRoute = (store: PushSubscriptionStoreShape) =>
  HttpRouter.add(
    "POST",
    SUBSCRIBE_ROUTE_PATH,
    Effect.gen(function* () {
      const session = yield* authenticateWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const rawBody = yield* Effect.orElseSucceed(request.json, () => null);
      if (rawBody === null) {
        return HttpServerResponse.text("Invalid body", { status: 400 });
      }
      const body = yield* decodeSubscribeBody(rawBody).pipe(
        Effect.map((decoded): typeof SubscribeBody.Type | null => decoded),
        Effect.orElseSucceed(() => null),
      );
      if (body === null || body.endpoint === "") {
        return HttpServerResponse.text("Invalid body", { status: 400 });
      }
      const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* store.upsert({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        sessionId: String(session.sessionId),
        createdAt,
      });
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const makeUnsubscribeRoute = (store: PushSubscriptionStoreShape) =>
  HttpRouter.add(
    "POST",
    UNSUBSCRIBE_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticateWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const rawBody = yield* Effect.orElseSucceed(request.json, () => null);
      if (rawBody === null) {
        return HttpServerResponse.text("Invalid body", { status: 400 });
      }
      const body = yield* decodeUnsubscribeBody(rawBody).pipe(
        Effect.map((decoded): typeof UnsubscribeBody.Type | null => decoded),
        Effect.orElseSucceed(() => null),
      );
      if (body === null || body.endpoint === "") {
        return HttpServerResponse.text("Invalid body", { status: 400 });
      }
      yield* store.removeByEndpoint(body.endpoint);
      return HttpServerResponse.jsonUnsafe({ ok: true });
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

/**
 * Mounted from `CoilRoutesLive`. `Layer.unwrap` resolves the store + VAPID once at layer
 * construction and the handlers close over the values, so neither requirement propagates into
 * upstream's `makeRoutesLayer` signature (see coil/autoResume/http.ts for the full rationale).
 */
export const webPushRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* PushSubscriptionStore;
    const vapid = yield* WebPushVapid;
    return Layer.mergeAll(
      makeVapidKeyRoute(vapid),
      makeSubscribeRoute(store),
      makeUnsubscribeRoute(store),
    );
  }),
);
