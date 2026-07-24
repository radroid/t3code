// @effect-diagnostics nodeBuiltinImport:off
/**
 * Route-level tests for `/api/t3x/auto-resume`.
 *
 * Serves ONLY the fork's route layer (not the whole `makeRoutesLayer`) over a real HTTP
 * server on an ephemeral port, with `EnvironmentAuth` mocked.
 *
 * Scope note: because auth is mocked, these tests do NOT prove that the route's
 * `authenticateWithOperateScope` faithfully mirrors upstream's private
 * `authenticateRawRouteWithScope` — that remains a logic mirror tracked in SEAMS.md.
 * What they DO prove is that a rejected credential and a missing scope each render as a
 * 401/403 through the route's `catchTags` rather than escaping as a 500 or an unhandled
 * defect, and that the GET/POST contract round-trips through a real store.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { autoResumeRouteLayer } from "./http.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./state.ts";

const PATH = "/api/t3x/auto-resume";

const authedSession = (scopes: ReadonlyArray<string>) =>
  ({
    sessionId: "test-session",
    subject: "test",
    method: "bearer-access-token",
    scopes,
  }) as unknown as EnvironmentAuth.AuthenticatedSession;

/** Mock auth that succeeds with the given scopes. */
const authOk = (scopes: ReadonlyArray<string> = [AuthOrchestrationOperateScope]) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () => Effect.succeed(authedSession(scopes)),
  });

/**
 * Mock auth that rejects the credential.
 *
 * Must be a member of the `ServerAuthCredentialError` union
 * (`ServerAuthMissingCredentialError | ServerAuthInvalidCredentialError`) — that union is
 * what `isServerAuthCredentialError` guards on. An error outside it (and outside
 * `ServerAuthInternalError`) matches neither `catchIf` branch and surfaces as a 500. That
 * is equally true of upstream's OTLP route, which uses the identical two branches, so it
 * is a shared property rather than a fork divergence.
 */
const authRejects = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: () =>
    Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
});

const baseUrl = (pathname: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const getJson = (pathname: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(yield* baseUrl(pathname));
  });

const postJson = (pathname: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(yield* baseUrl(pathname)),
      body,
    );
    return yield* client.execute(request);
  });

/** Serves the route over an ephemeral port with the given auth layer and a real store. */
const withRoute = <A, E>(
  authLayer: Layer.Layer<EnvironmentAuth.EnvironmentAuth>,
  body: Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>,
): Promise<A> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-http-" });
    const storeLayer = Layer.effect(
      AutoResumeStore,
      makeAutoResumeStore(NodePath.join(root, "state.json")),
    );

    const served = HttpRouter.serve(autoResumeRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(storeLayer),
      Layer.provide(authLayer),
      // provideMerge, not provide: the test body needs HttpServer in context to read the
      // ephemeral port off `server.address`.
      Layer.provideMerge(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 })),
    );

    return yield* body.pipe(Effect.provide(served), Effect.provide(FetchHttpClient.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

describe("/api/t3x/auto-resume", () => {
  it("rejects a bad credential with 401/403 instead of leaking a 500", () =>
    withRoute(
      authRejects,
      Effect.gen(function* () {
        const res = yield* getJson(`${PATH}?threadId=thread-a`);
        assert.isTrue(
          res.status === 401 || res.status === 403,
          `expected 401/403 for a rejected credential, got ${res.status}`,
        );
      }),
    ));

  it("rejects a session lacking the operate scope", () =>
    withRoute(
      authOk([]),
      Effect.gen(function* () {
        const res = yield* getJson(`${PATH}?threadId=thread-a`);
        assert.isTrue(
          res.status === 401 || res.status === 403,
          `expected 401/403 without the operate scope, got ${res.status}`,
        );
      }),
    ));

  it("GET defaults a never-seen thread to enabled", () =>
    withRoute(
      authOk(),
      Effect.gen(function* () {
        const res = yield* getJson(`${PATH}?threadId=fresh`);
        assert.strictEqual(res.status, 200);
        const body = (yield* res.json) as Record<string, unknown>;
        assert.strictEqual(body.enabled, true);
        assert.strictEqual(body.overridePrompt, null);
        assert.strictEqual(body.pending, null);
      }),
    ));

  it("GET without a threadId is a 400, not a crash", () =>
    withRoute(
      authOk(),
      Effect.gen(function* () {
        const res = yield* getJson(PATH);
        assert.strictEqual(res.status, 400);
      }),
    ));

  it("POST patches one field without clobbering the other", () =>
    withRoute(
      authOk(),
      Effect.gen(function* () {
        const off = yield* postJson(PATH, { threadId: "t1", enabled: false });
        assert.strictEqual(off.status, 200);
        assert.strictEqual(((yield* off.json) as Record<string, unknown>).enabled, false);

        // Writing only overridePrompt must not resurrect `enabled`.
        const text = yield* postJson(PATH, { threadId: "t1", overridePrompt: "keep going" });
        const textBody = (yield* text.json) as Record<string, unknown>;
        assert.strictEqual(textBody.overridePrompt, "keep going");
        assert.strictEqual(textBody.enabled, false, "a prompt write must not clobber enabled");

        // …and writing only `enabled` must not wipe the prompt.
        const on = yield* postJson(PATH, { threadId: "t1", enabled: true });
        const onBody = (yield* on.json) as Record<string, unknown>;
        assert.strictEqual(onBody.enabled, true);
        assert.strictEqual(onBody.overridePrompt, "keep going", "toggle must not clobber prompt");
      }),
    ));

  it("POST with a malformed body is a 400, not a 500", () =>
    withRoute(
      authOk(),
      Effect.gen(function* () {
        const res = yield* postJson(PATH, { nope: true });
        assert.strictEqual(res.status, 400);
      }),
    ));
});
