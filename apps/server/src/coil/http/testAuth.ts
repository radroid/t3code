// @effect-diagnostics nodeBuiltinImport:off
/**
 * Test-only scaffolding for the fork's raw HTTP routes.
 *
 * Every coil route authenticates through `coil/http/auth.ts`, so every route test needs the
 * same three things: a mocked `EnvironmentAuth`, a real server on an ephemeral port, and a
 * client pointed at it. They were pasted per feature; this is the one copy.
 *
 * NOT a `.test.ts` file on purpose — vitest must not collect it, and nothing in the server
 * bundle imports it, so it is dropped from `vp pack` output the same way
 * `coil/autoResume/replay/reactorHarness.ts` is.
 *
 * @module coil/http/testAuth
 */

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as NodeHttp from "node:http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

/**
 * A session shaped like the real thing in the fields the auth helper reads (`scopes`,
 * `sessionId`). Cast because the full `AuthenticatedSession` carries branded ids and a
 * `DateTime` expiry that no assertion here depends on.
 */
export const authedSession = (scopes: ReadonlyArray<string>) =>
  ({
    sessionId: "test-session",
    subject: "test",
    method: "bearer-access-token",
    scopes,
  }) as unknown as EnvironmentAuth.AuthenticatedSession;

/** Auth that succeeds, granting exactly `scopes`. */
export const authOk = (scopes: ReadonlyArray<string>) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () => Effect.succeed(authedSession(scopes)),
  });

/**
 * Auth that fails with `error`.
 *
 * The error must be a member of `ServerAuthCredentialError` or `ServerAuthInternalError` —
 * those two unions are what the helper's `catchIf` branches guard on, and anything outside
 * them matches neither and surfaces as a 500. That is equally true of upstream's OTLP route,
 * which uses the identical two branches, so it is a shared property rather than a fork
 * divergence.
 */
export const authFails = (
  error: EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError,
) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () => Effect.fail(error),
  });

export const baseUrl = (pathname: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

export const getJson = (pathname: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(yield* baseUrl(pathname));
  });

export const postJson = (pathname: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(yield* baseUrl(pathname)),
      body,
    );
    return yield* client.execute(request);
  });

/**
 * A POST whose body is **not** JSON, sent with a JSON content type.
 *
 * This is the shape a broken client, a proxy that rewrote a body, or a mistyped `curl`
 * produces, and it is the one path that never reaches a route's own decoder — so it is also
 * the one that quietly returns a bare, uncoded 400 unless the route handles it.
 */
export const postText = (pathname: string, body: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.bodyText(
      HttpClientRequest.post(yield* baseUrl(pathname)),
      body,
      "application/json",
    );
    return yield* client.execute(request);
  });

/** Reads a JSON response body as a plain record, for field-by-field assertions. */
export const jsonBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(response.json, (value) => value as Record<string, unknown>);

/**
 * Serves `routes` over an ephemeral port with `deps` provided, and runs `body` against it.
 *
 * Anything `deps` does not satisfy stays in the returned effect's requirements, so a missing
 * dependency is a type error at `runServed`, not a runtime surprise.
 */
export const serveRoutes = <RA, RE, RR, DA, DE, DR, A, E>(options: {
  readonly routes: Layer.Layer<RA, RE, RR>;
  readonly deps: Layer.Layer<DA, DE, DR>;
  readonly body: Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>;
}) => {
  const served = HttpRouter.serve(options.routes, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(options.deps),
    // provideMerge, not provide: the body needs HttpServer in context to read the ephemeral
    // port off `server.address`.
    Layer.provideMerge(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 })),
  );
  return options.body.pipe(Effect.provide(Layer.merge(served, FetchHttpClient.layer)));
};

/**
 * Discharges the platform services a served route needs and runs it as a promise.
 *
 * The parameter type is the check that matters: `R` is contravariant, so an effect needing
 * fewer services still fits, while one that still needs a feature dependency (its store, say)
 * does not compile — rather than failing at runtime with a missing-service defect.
 */
export const runServed = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
): Promise<A> => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
