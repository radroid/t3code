/**
 * Web Push delivery — a thin Effect wrapper over the `web-push` library.
 *
 * Isolated in one module so the CommonJS dependency and its VAPID/AES128GCM encryption are
 * easy to swap or mock. Never fails its Effect: a rejected send resolves to a result flagging
 * whether the subscription is gone (404/410) so the caller can prune it.
 *
 * @module coil/webPush/send
 */

import * as Effect from "effect/Effect";
import webpush from "web-push";

import type { AttentionPushPayload } from "./attention.ts";
import type { PushSubscriptionRecord } from "./state.ts";
import type { WebPushVapidKeys } from "./vapid.ts";

/** How long the push service holds an undelivered message. A needs-you alert is stale after a few hours. */
const PUSH_TTL_SECONDS = 4 * 60 * 60;

export interface WebPushSendResult {
  readonly ok: boolean;
  /** True when the push service reports the subscription is gone (404/410) — prune it. */
  readonly expired: boolean;
}

function extractStatusCode(error: unknown): number | undefined {
  const outer = error as { statusCode?: unknown; error?: unknown; cause?: unknown } | null;
  if (typeof outer?.statusCode === "number") return outer.statusCode;
  const inner = (outer?.error ?? outer?.cause) as { statusCode?: unknown } | undefined;
  return typeof inner?.statusCode === "number" ? inner.statusCode : undefined;
}

export const sendWebPush = (
  vapid: WebPushVapidKeys,
  subscription: PushSubscriptionRecord,
  payload: AttentionPushPayload,
): Effect.Effect<WebPushSendResult> =>
  Effect.tryPromise(() =>
    webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      // @effect-diagnostics-next-line preferSchemaOverJson:off - web-push requires a JSON string payload for the wire.
      JSON.stringify(payload),
      {
        TTL: PUSH_TTL_SECONDS,
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      },
    ),
  ).pipe(
    Effect.as({ ok: true, expired: false } satisfies WebPushSendResult),
    Effect.catch((error: unknown) => {
      const statusCode = extractStatusCode(error);
      return Effect.succeed({
        ok: false,
        // 404/410 = subscription gone; 403 = VAPID key mismatch (undeliverable for this
        // server key). Prune all so the client re-subscribes with the current key.
        expired: statusCode === 404 || statusCode === 410 || statusCode === 403,
      } satisfies WebPushSendResult);
    }),
  );
