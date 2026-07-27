/**
 * Fork-owned raw HTTP routes backing Web Push subscription management.
 *
 *   GET  /api/t3x/push/vapid-public-key  -> { publicKey }        (read scope)
 *   POST /api/t3x/push/subscribe         -> { ok: true }         (operate scope)
 *   POST /api/t3x/push/unsubscribe       -> { ok: true }         (operate scope)
 *
 * Raw routes, not WS-RPC: an RPC would force edits to `@t3tools/contracts` + `ws.ts` + its
 * scope map. These mount via `T3xRoutesLive` in t3x/index.ts, so server.ts is untouched.
 * See docs/t3x/SEAMS.md and t3x/autoResume/http.ts (the mirrored template).
 *
 * @module t3x/webPush/http
 */

import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import { PushSubscriptionStore, type PushSubscriptionStoreShape } from "./state.ts";
import { WebPushVapid, type WebPushVapidKeys } from "./vapid.ts";

export const VAPID_KEY_ROUTE_PATH = "/api/t3x/push/vapid-public-key";
export const SUBSCRIBE_ROUTE_PATH = "/api/t3x/push/subscribe";
export const UNSUBSCRIBE_ROUTE_PATH = "/api/t3x/push/unsubscribe";

/**
 * MIRROR of the module-private raw-route auth in apps/server/src/http.ts (also mirrored by
 * t3x/autoResume/http.ts). Returns the session so the subscribe route can record which device
 * registered. Registered as a logic mirror in docs/t3x/SEAMS.md.
 */
const authenticateWithScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
    return session;
  });

const respondableTags = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;

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
    }).pipe(Effect.catchTags(respondableTags)),
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
    }).pipe(Effect.catchTags(respondableTags)),
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
    }).pipe(Effect.catchTags(respondableTags)),
  );

/**
 * Mounted from `T3xRoutesLive`. `Layer.unwrap` resolves the store + VAPID once at layer
 * construction and the handlers close over the values, so neither requirement propagates into
 * upstream's `makeRoutesLayer` signature (see t3x/autoResume/http.ts for the full rationale).
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
