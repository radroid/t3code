// @effect-diagnostics nodeBuiltinImport:off
/**
 * Route-level tests for `/api/coil/auto-resume`.
 *
 * Serves ONLY the fork's route layer (not the whole `makeRoutesLayer`) over a real HTTP
 * server on an ephemeral port, with `EnvironmentAuth` mocked (see `coil/http/testAuth.ts`).
 *
 * Scope note: because auth is mocked, these tests do NOT prove that the shared
 * `coil/http/auth.ts` helper faithfully mirrors upstream's private
 * `authenticateRawRouteWithScope` — that remains a logic mirror tracked in SEAMS.md.
 * What they DO prove is that a rejected credential and a missing scope each render through
 * the route's `catchTags` rather than escaping as a 500 or an unhandled defect, and that the
 * GET/POST contract round-trips through a real store. The helper's own bodies are pinned in
 * `coil/http/auth.test.ts`.
 */
import { assert, describe, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { HttpClient, HttpServer } from "effect/unstable/http";
import * as NodePath from "node:path";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { authFails, authOk, getJson, postJson, runServed, serveRoutes } from "../http/testAuth.ts";
import { autoResumeRouteLayer } from "./http.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./state.ts";

const PATH = "/api/coil/auto-resume";

const authRejects = authFails(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));

/** Serves the route over an ephemeral port with the given auth layer and a real store. */
const withRoute = <A, E>(
  auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>,
  body: Effect.Effect<A, E, HttpServer.HttpServer | HttpClient.HttpClient>,
) =>
  runServed(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-http-" });
      const storeLayer = Layer.effect(
        AutoResumeStore,
        makeAutoResumeStore(NodePath.join(root, "state.json")),
      );
      return yield* serveRoutes({
        routes: autoResumeRouteLayer,
        deps: Layer.merge(storeLayer, auth),
        body,
      });
    }),
  );

describe("/api/coil/auto-resume", () => {
  it("rejects a bad credential with a 401 instead of leaking a 500", () =>
    withRoute(
      authRejects,
      Effect.gen(function* () {
        const res = yield* getJson(`${PATH}?threadId=thread-a`);
        assert.strictEqual(res.status, 401);
      }),
    ));

  it("rejects a session lacking the operate scope with a 403", () =>
    withRoute(
      authOk([]),
      Effect.gen(function* () {
        const res = yield* getJson(`${PATH}?threadId=thread-a`);
        assert.strictEqual(res.status, 403);
      }),
    ));

  it("GET defaults a never-seen thread to enabled", () =>
    withRoute(
      authOk([AuthOrchestrationOperateScope]),
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
      authOk([AuthOrchestrationOperateScope]),
      Effect.gen(function* () {
        const res = yield* getJson(PATH);
        assert.strictEqual(res.status, 400);
      }),
    ));

  it("POST patches one field without clobbering the other", () =>
    withRoute(
      authOk([AuthOrchestrationOperateScope]),
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

  // This route is what makes threadId caller-controlled; before it, ids only ever came
  // from provider events. A prototype-chain id used to resolve on Object.prototype, which
  // 500'd on read and persisted a malformed record that wiped the whole state file on the
  // next boot. Pinned here at the HTTP boundary, not just in the store.
  it("handles a prototype-chain threadId as an ordinary unknown thread", () =>
    withRoute(
      authOk([AuthOrchestrationOperateScope]),
      Effect.gen(function* () {
        for (const hostile of ["constructor", "__proto__", "toString"]) {
          const res = yield* getJson(`${PATH}?threadId=${encodeURIComponent(hostile)}`);
          assert.strictEqual(res.status, 200, `GET threadId=${hostile} must not 500`);
          const body = (yield* res.json) as Record<string, unknown>;
          assert.strictEqual(body.enabled, true);
          assert.strictEqual(body.pending, null);
        }

        const wrote = yield* postJson(PATH, { threadId: "__proto__", enabled: false });
        assert.strictEqual(wrote.status, 200, "POST threadId=__proto__ must not 500");
        assert.strictEqual(((yield* wrote.json) as Record<string, unknown>).enabled, false);
      }),
    ));

  it("POST with a malformed body is a 400, not a 500", () =>
    withRoute(
      authOk([AuthOrchestrationOperateScope]),
      Effect.gen(function* () {
        const res = yield* postJson(PATH, { nope: true });
        assert.strictEqual(res.status, 400);
      }),
    ));
});
