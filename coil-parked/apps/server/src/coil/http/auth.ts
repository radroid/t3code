/**
 * Raw-route authentication shared by every fork-owned HTTP route.
 *
 * MIRROR of the module-private `authenticateRawRouteWithScope` in `apps/server/src/http.ts`
 * (which the OTLP proxy route uses). It is not exported, so importing it would mean editing
 * an upstream file; the fork replicates the ~15 lines instead. Registered as a logic mirror
 * in docs/coil/SEAMS.md — if upstream changes how raw routes authenticate, this must follow.
 *
 * It lives here, and not beside a route, because there is exactly ONE mirror to keep faithful.
 * `autoResume/http.ts` and `webPush/http.ts` each grew their own copy and immediately drifted
 * (only one of them reported the DPoP failure reason); the next fork route calls this instead
 * of pasting a third.
 *
 * @module coil/http/auth
 */

import type { AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";

/**
 * Authenticates the in-flight request and asserts `scope`, failing with the same typed
 * errors every other environment endpoint uses: `EnvironmentAuthInvalidError` (401),
 * `EnvironmentScopeRequiredError` (403), `EnvironmentInternalError` (500).
 *
 * `dpopFailureReason` is forwarded because upstream's raw-route mirror forwards it; without
 * it a relay client loses the precise reason (clock skew being the motivating case) that
 * every other environment endpoint reports.
 *
 * Returns the authenticated session, so a route that needs to record *which* device called
 * (Web Push subscribe) does not have to authenticate twice. Callers that only need the
 * gate can discard it.
 */
export const authenticateWithScope = (scope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
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

/**
 * Renders the three failures `authenticateWithScope` can raise as their own responses.
 *
 * Pass to `Effect.catchTags` on every fork route handler: a raw route has no `HttpApi`
 * wrapper to do it, so an uncaught typed error escapes as a 500 instead of the 401/403 the
 * client expects. Promoted alongside the helper it belongs to — the two were pasted together
 * into both route modules.
 */
export const routeAuthErrorTags = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
} as const;
