// @effect-diagnostics nodeBuiltinImport:off
/**
 * Route-level tests for `/api/coil/push/*`.
 *
 * These routes used to carry their own paste of the raw-route auth mirror and had no test at
 * all, which is how they came to drop `dpopFailureReason` without anyone noticing. Now they
 * share `coil/http/auth.ts`, so this suite pins what a Web Push client actually sees: the
 * status per failure, the DPoP reason on the wire, and the fact that a subscribe is recorded
 * against the calling session (the reason the helper returns one).
 *
 * Serves ONLY the fork's route layer over a real HTTP server on an ephemeral port, with
 * `EnvironmentAuth` mocked (see `coil/http/testAuth.ts`).
 */
import { assert, describe, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { HttpClient, HttpServer } from "effect/unstable/http";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  authFails,
  authOk,
  getJson,
  jsonBody,
  postJson,
  runServed,
  serveRoutes,
} from "../http/testAuth.ts";
import {
  SUBSCRIBE_ROUTE_PATH,
  UNSUBSCRIBE_ROUTE_PATH,
  VAPID_KEY_ROUTE_PATH,
  webPushRouteLayer,
} from "./http.ts";
import {
  makePushSubscriptionStore,
  PushSubscriptionStore,
  type PushSubscriptionStoreShape,
} from "./state.ts";
import { WebPushVapid } from "./vapid.ts";

const VAPID = {
  publicKey: "test-public-key",
  privateKey: "test-private-key",
  subject: "mailto:test@example.com",
} as const;

const SUBSCRIPTION = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

/**
 * Serves the routes with a real store on a temp file. The store value is built first and
 * handed to the layer, so a test can read what the route wrote without going back over HTTP.
 */
const withRoutes = <A, E>(
  auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>,
  body: (
    store: PushSubscriptionStoreShape,
  ) => Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>,
) =>
  runServed(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-push-http-" });
      const store = yield* makePushSubscriptionStore(NodePath.join(root, "push.json"));
      return yield* serveRoutes({
        routes: webPushRouteLayer,
        deps: Layer.mergeAll(
          Layer.succeed(PushSubscriptionStore, store),
          Layer.succeed(WebPushVapid, VAPID),
          auth,
        ),
        body: body(store),
      });
    }),
  );

describe("/api/coil/push", () => {
  it("rejects a missing credential with a 401", () =>
    withRoutes(authFails(new EnvironmentAuth.ServerAuthMissingCredentialError({})), () =>
      Effect.gen(function* () {
        const res = yield* getJson(VAPID_KEY_ROUTE_PATH);
        assert.strictEqual(res.status, 401);
        assert.strictEqual((yield* jsonBody(res)).reason, "missing_credential");
      }),
    ));

  // The one declared behaviour change of the auth promotion: before it, these three routes
  // rendered a bare 401 and a client behind a skewed clock could not tell why. Pinned at the
  // route, not just at the helper, because that is where it regressed.
  it("reports the DPoP failure reason on a rejected credential", () =>
    withRoutes(
      authFails(
        new EnvironmentAuth.ServerAuthInvalidCredentialError({ dpopFailureReason: "time_window" }),
      ),
      () =>
        Effect.gen(function* () {
          const res = yield* postJson(SUBSCRIBE_ROUTE_PATH, SUBSCRIPTION);
          assert.strictEqual(res.status, 401);
          const body = yield* jsonBody(res);
          assert.strictEqual(body.reason, "invalid_credential");
          assert.strictEqual(body.dpopFailureReason, "time_window");
        }),
    ));

  it("rejects a read-only session from subscribe with a 403", () =>
    withRoutes(authOk([AuthOrchestrationReadScope]), (store) =>
      Effect.gen(function* () {
        const res = yield* postJson(SUBSCRIBE_ROUTE_PATH, SUBSCRIPTION);
        assert.strictEqual(res.status, 403);
        assert.strictEqual((yield* jsonBody(res)).requiredScope, AuthOrchestrationOperateScope);
        assert.lengthOf(yield* store.list, 0, "a refused subscribe must not reach the store");
      }),
    ));

  it("serves the VAPID public key to a read-scoped session", () =>
    withRoutes(authOk([AuthOrchestrationReadScope]), () =>
      Effect.gen(function* () {
        const res = yield* getJson(VAPID_KEY_ROUTE_PATH);
        assert.strictEqual(res.status, 200);
        assert.strictEqual((yield* jsonBody(res)).publicKey, VAPID.publicKey);
      }),
    ));

  it("records a subscribe against the calling session, and drops it on unsubscribe", () =>
    withRoutes(authOk([AuthOrchestrationOperateScope]), (store) =>
      Effect.gen(function* () {
        const subscribed = yield* postJson(SUBSCRIBE_ROUTE_PATH, SUBSCRIPTION);
        assert.strictEqual(subscribed.status, 200);
        assert.strictEqual((yield* jsonBody(subscribed)).ok, true);

        // The session id is the reason the shared helper returns the session at all: the
        // subscribe route records which device registered.
        const stored = yield* store.list;
        assert.deepStrictEqual(
          stored.map((record) => ({ endpoint: record.endpoint, sessionId: record.sessionId })),
          [{ endpoint: SUBSCRIPTION.endpoint, sessionId: "test-session" }],
        );

        const removed = yield* postJson(UNSUBSCRIBE_ROUTE_PATH, {
          endpoint: SUBSCRIPTION.endpoint,
        });
        assert.strictEqual(removed.status, 200);
        assert.lengthOf(yield* store.list, 0);
      }),
    ));
});
