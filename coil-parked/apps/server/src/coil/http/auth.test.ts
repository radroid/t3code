/**
 * Behaviour tests for the shared raw-route auth helper.
 *
 * The route suites only assert the status a caller sees for their own endpoints. This pins
 * the helper itself, once, for every fork route that shares it: all three typed failures with
 * their exact statuses and bodies, the forwarded DPoP reason (the drift that existed while
 * there were two copies), and the fact that an authorised caller gets the session back.
 *
 * Auth itself is mocked, so this does NOT prove the helper still mirrors upstream's private
 * `authenticateRawRouteWithScope` — that stays a logic mirror tracked in docs/coil/SEAMS.md.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { authenticateWithScope, routeAuthErrorTags } from "./auth.ts";
import { authFails, authOk, getJson, jsonBody, runServed, serveRoutes } from "./testAuth.ts";

const PATH = "/probe";

/**
 * A route that does nothing but authenticate and echo the session id back, so the assertions
 * read the helper's output rather than some feature's response shape.
 */
const probeRoute = (scope: AuthEnvironmentScope) =>
  HttpRouter.add(
    "GET",
    PATH,
    Effect.gen(function* () {
      const session = yield* authenticateWithScope(scope);
      return HttpServerResponse.jsonUnsafe({ sessionId: String(session.sessionId) });
    }).pipe(Effect.catchTags(routeAuthErrorTags)),
  );

const callProbe = (
  auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>,
  scope: AuthEnvironmentScope,
) =>
  runServed(
    serveRoutes({
      routes: probeRoute(scope),
      deps: auth,
      body: Effect.gen(function* () {
        const response = yield* getJson(PATH);
        return { status: response.status, body: yield* jsonBody(response) };
      }),
    }),
  );

describe("authenticateWithScope", () => {
  it("renders a missing credential as a 401 auth_invalid body", async () => {
    const { status, body } = await callProbe(
      authFails(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(status, 401);
    assert.strictEqual(body.code, "auth_invalid");
    assert.strictEqual(body.reason, "missing_credential");
  });

  // The two pre-promotion copies disagreed here: only the auto-resume one forwarded the
  // reason, so a Web Push client behind a skewed clock got a bare 401 it could not act on.
  // The promotion reconciled to the forwarding form, which is what upstream's raw-route
  // auth does; this is the case that would notice a regression back to the other one.
  it("forwards the DPoP failure reason on an invalid credential", async () => {
    const { status, body } = await callProbe(
      authFails(
        new EnvironmentAuth.ServerAuthInvalidCredentialError({ dpopFailureReason: "time_window" }),
      ),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(status, 401);
    assert.strictEqual(body.reason, "invalid_credential");
    assert.strictEqual(body.dpopFailureReason, "time_window");
  });

  // The third branch, and the one a route would otherwise leak as an unhandled defect: an
  // internal auth failure is a 500 with a body, not a bare crash.
  it("renders an internal auth failure as a 500 internal_error body", async () => {
    const { status, body } = await callProbe(
      authFails(new EnvironmentAuth.ServerAuthSessionCredentialValidationError({ cause: "boom" })),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(status, 500);
    assert.strictEqual(body.code, "internal_error");
    assert.strictEqual(body.reason, "internal_error");
    assert.isString(body.traceId);
  });

  it("renders a missing scope as a 403 naming the scope it wanted", async () => {
    const { status, body } = await callProbe(
      authOk([AuthOrchestrationReadScope]),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(status, 403);
    assert.strictEqual(body.code, "insufficient_scope");
    assert.strictEqual(body.requiredScope, AuthOrchestrationOperateScope);
  });

  it("passes the session through once the scope is held", async () => {
    const { status, body } = await callProbe(
      authOk([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      AuthOrchestrationOperateScope,
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.sessionId, "test-session");
  });
});
