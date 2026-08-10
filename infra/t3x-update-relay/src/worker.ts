import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { describeParseFailure, parseNotification } from "./notification.ts";
import { describeSignatureFailure, verifySignature } from "./signature.ts";

export { UpdateChannel } from "./UpdateChannel.ts";

export interface Env {
  readonly UPDATE_CHANNEL: DurableObjectNamespace;
  /** Shared with the release workflow. The only secret in the whole update-delivery system. */
  readonly T3X_UPDATE_HMAC_SECRET: string;
}

/**
 * A single, fixed Durable Object instance.
 *
 * There is one channel because there is one thing to broadcast. Naming it explicitly (rather than
 * deriving an id per request) is what makes every subscriber and every publisher land on the same
 * object.
 */
const CHANNEL_NAME = "t3x-update-channel-v1";

function channel(env: Env): DurableObjectStub {
  return env.UPDATE_CHANNEL.get(env.UPDATE_CHANNEL.idFromName(CHANNEL_NAME));
}

/**
 * Read paths are open on purpose.
 *
 * This fork is a public repository, so "main moved to <sha>, here is the artifact" is already
 * public. Adding subscriber tokens would buy no confidentiality and would cost every client a
 * provisioning step and us a revocation story. The write path is authenticated because *that* is
 * where the leverage is: forging a notify would restart every installed app into an artifact of
 * the attacker's choosing.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
  });
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  if (env.T3X_UPDATE_HMAC_SECRET === undefined || env.T3X_UPDATE_HMAC_SECRET === "") {
    // Fail closed. An unset secret must never degrade into an unauthenticated write path.
    return json({ accepted: false, reason: "relay-misconfigured" }, 500);
  }

  const rawBody = await request.text();

  const nowSeconds = Math.floor(
    DateTime.toEpochMillis(await Effect.runPromise(DateTime.now)) / 1000,
  );

  const signature = await verifySignature({
    secret: env.T3X_UPDATE_HMAC_SECRET,
    signatureHeader: request.headers.get("x-t3x-signature"),
    timestampHeader: request.headers.get("x-t3x-timestamp"),
    rawBody,
    nowSeconds,
  });
  if (!signature.ok) {
    return json(
      {
        accepted: false,
        reason: signature.failure.kind,
        detail: describeSignatureFailure(signature.failure),
      },
      401,
    );
  }

  // Parsed here as well as in the Durable Object so a malformed body is rejected with a useful
  // message before it costs a DO round trip.
  const parsed = parseNotification(rawBody);
  if (!parsed.ok) {
    return json(
      {
        accepted: false,
        reason: parsed.failure.kind,
        detail: describeParseFailure(parsed.failure),
      },
      400,
    );
  }

  // Guarded because a Durable Object stub can throw for reasons that are nobody's bug — a
  // storage-flush stall or an object reset mid-request. Unguarded, that surfaces to the caller
  // as Cloudflare's bare `error code: 1101` page, which is what build 20's release run got:
  // thirty seconds of hang, an opaque 500, and no way to tell that the publish had in fact
  // durably applied. A 503 with a reason gives the workflow's retry loop something to act on.
  let response: Response;
  try {
    response = await channel(env).fetch("https://channel/internal/publish", {
      method: "POST",
      body: rawBody,
    });
  } catch (error) {
    return json({ accepted: false, reason: "channel-unavailable", detail: String(error) }, 503);
  }

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      return handleNotify(request, env);
    }

    if (url.pathname === "/latest" && request.method === "GET") {
      const response = await channel(env).fetch("https://channel/internal/latest");
      return new Response(await response.text(), {
        status: response.status,
        headers: {
          "content-type": "application/json",
          // Explicitly uncacheable. `/latest` is the fallback tier for clients whose push
          // connection died; serving them an edge-cached copy would mean the backstop reports
          // the same stale answer the broken push path was already giving them.
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      return channel(env).fetch("https://channel/internal/events");
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true }, 200);
    }

    return json({ error: "not-found" }, 404);
  },
} satisfies ExportedHandler<Env>;
