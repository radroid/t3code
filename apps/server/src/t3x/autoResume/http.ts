/**
 * Fork-owned raw HTTP route backing the per-thread auto-resume control.
 *
 *   GET  /api/t3x/auto-resume?threadId=…  -> { enabled, overridePrompt, pending }
 *   POST /api/t3x/auto-resume             -> same shape, after applying the write
 *
 * Deliberately a *raw* route rather than a WS-RPC method: adding an RPC would force edits
 * to `@t3tools/contracts` (`WsRpcGroup`, `WS_METHODS`) plus `apps/server/src/ws.ts` and its
 * scope map — several hot upstream files. A raw route costs exactly one additive line in
 * `server.ts`'s route list instead. See docs/t3x/SEAMS.md.
 *
 * @module t3x/autoResume/http
 */

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { AutoResumeStore, type AutoResumeStoreShape } from "./state.ts";

export const AUTO_RESUME_ROUTE_PATH = "/api/t3x/auto-resume";

/**
 * MIRROR of the module-private `authenticateRawRouteWithScope` in `apps/server/src/http.ts`
 * (which the OTLP proxy route uses). It is not exported, so importing it would mean editing
 * an upstream file; the fork replicates the ~15 lines instead. Registered as a logic mirror
 * in docs/t3x/SEAMS.md — if upstream changes how raw routes authenticate, this must follow.
 *
 * Operate (not read) scope: these endpoints mutate scheduling behaviour.
 */
const authenticateWithOperateScope = Effect.gen(function* () {
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
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthOrchestrationOperateScope);
  }
});

const WriteBody = Schema.Struct({
  threadId: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  overridePrompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeWriteBody = Schema.decodeUnknownEffect(WriteBody);

/**
 * The wire shape shared by GET and POST responses.
 *
 * Takes the store as an argument instead of `yield*`-ing it from context. That is what
 * keeps `AutoResumeStore` out of the *handler's* requirements — see `autoResumeRouteLayer`.
 */
const readThreadState = (store: AutoResumeStoreShape, threadId: string) =>
  Effect.gen(function* () {
    const record = yield* store.getThread(threadId);
    return {
      enabled: record.enabled,
      overridePrompt: record.overridePrompt,
      pending:
        record.pending === null
          ? null
          : { resumeAtMs: record.pending.resumeAtMs, reason: record.pending.reason },
    };
  });

const makeGetRoute = (store: AutoResumeStoreShape) =>
  HttpRouter.add(
    "GET",
    AUTO_RESUME_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticateWithOperateScope;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (Option.isNone(url)) {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }
      const threadId = url.value.searchParams.get("threadId");
      if (threadId === null || threadId === "") {
        return HttpServerResponse.text("Missing threadId", { status: 400 });
      }
      return HttpServerResponse.jsonUnsafe(yield* readThreadState(store, threadId));
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );

const makePostRoute = (store: AutoResumeStoreShape) =>
  HttpRouter.add(
    "POST",
    AUTO_RESUME_ROUTE_PATH,
    Effect.gen(function* () {
      yield* authenticateWithOperateScope;
      const request = yield* HttpServerRequest.HttpServerRequest;

      const body = yield* decodeWriteBody(yield* request.json).pipe(
        Effect.map((decoded): typeof WriteBody.Type | null => decoded),
        // A malformed body is a client error, not a 500.
        Effect.orElseSucceed(() => null),
      );
      if (body === null || body.threadId === "") {
        return HttpServerResponse.text("Invalid body", { status: 400 });
      }

      // Both fields are optional so the UI can PATCH one without clobbering the other:
      // the toggle must not wipe a resume message the user is mid-way through typing.
      if (body.enabled !== undefined) {
        yield* store.setEnabled(body.threadId, body.enabled);
      }
      if (body.overridePrompt !== undefined) {
        yield* store.setOverridePrompt(body.threadId, body.overridePrompt);
      }

      return HttpServerResponse.jsonUnsafe(yield* readThreadState(store, body.threadId));
    }).pipe(
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    ),
  );

/**
 * Mounted from `server.ts`'s route list — the fork's only route seam.
 *
 * `Layer.unwrap` resolves `AutoResumeStore` once, at *layer construction*, and the handlers
 * close over the resulting value. This is load-bearing: if the handlers `yield*`-ed the store
 * from context instead, that requirement would propagate out through `HttpRouter` into the
 * type of upstream's `makeRoutesLayer`, and every existing `server.test.ts` / `bin.test.ts`
 * case that builds it would stop type-checking. A fork change must never widen an upstream
 * signature. Here the requirement lands on the *layer* instead, where `t3x/index.ts`
 * discharges it with `Layer.provide(AutoResumeStoreLive)`.
 */
export const autoResumeRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* AutoResumeStore;
    return Layer.merge(makeGetRoute(store), makePostRoute(store));
  }),
);
