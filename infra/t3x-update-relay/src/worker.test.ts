import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

// The entry module re-exports the Durable Object class (wrangler requires that), which drags in
// `cloudflare:workers` — a runtime-only module that does not exist under node. The class itself
// is irrelevant here: these tests exercise the Worker's routing shell, not the channel.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { createSignature } from "./signature.ts";
import worker, { type Env } from "./worker.ts";

const SECRET = "test-secret";

function envWithChannel(fetchImpl: () => Promise<Response>): Env {
  return {
    T3X_UPDATE_HMAC_SECRET: SECRET,
    UPDATE_CHANNEL: {
      idFromName: () => ({}),
      get: () => ({ fetch: fetchImpl }),
    },
  } as unknown as Env;
}

async function signedNotify(env: Env): Promise<Response> {
  const rawBody = JSON.stringify({ buildNumber: 21 });
  const timestamp = Math.floor(
    DateTime.toEpochMillis(await Effect.runPromise(DateTime.now)) / 1000,
  );
  const signature = await createSignature({ secret: SECRET, timestamp, rawBody });
  const request = new Request("https://relay.example/notify", {
    method: "POST",
    headers: { "x-t3x-timestamp": String(timestamp), "x-t3x-signature": signature },
    body: rawBody,
  });
  return worker.fetch(request, env);
}

describe("POST /notify", () => {
  it("passes the channel's verdict through untouched", async () => {
    const env = envWithChannel(() =>
      Promise.resolve(Response.json({ accepted: true, buildNumber: 21 })),
    );
    const response = await signedNotify(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, buildNumber: 21 });
  });

  it("turns a thrown channel round trip into a 503 the caller can read", async () => {
    // Build 20's release run hit exactly this: the Durable Object stub threw a transient runtime
    // exception, the exception escaped `fetch`, and the workflow saw Cloudflare's bare
    // `error code: 1101` page — indistinguishable from a real rejection, and unretriable on
    // evidence. The failure must come back as JSON with a reason.
    const env = envWithChannel(() => Promise.reject(new Error("Durable Object reset")));
    const response = await signedNotify(env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      accepted: false,
      reason: "channel-unavailable",
      detail: "Error: Durable Object reset",
    });
  });
});
