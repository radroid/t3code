/**
 * VAPID keypair provisioning for Web Push.
 *
 * Env-provided keys (`T3X_VAPID_PUBLIC_KEY` + `T3X_VAPID_PRIVATE_KEY`) win; otherwise a
 * keypair is generated once and persisted in the ServerSecretStore (same place link/relay
 * secrets live), then reused. Never fails: a persistence error falls back to an in-memory
 * keypair for the session (logged) so push still works until the next restart.
 *
 * @module t3x/webPush/vapid
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import webpush from "web-push";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import type { WebPushConfig } from "./config.ts";

export interface WebPushVapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export class WebPushVapid extends Context.Service<WebPushVapid, WebPushVapidKeys>()(
  "t3/t3x/webPush/vapid/WebPushVapid",
) {}

const SECRET_NAME = "t3x-web-push-vapid";

const VapidKeypair = Schema.Struct({
  publicKey: Schema.String,
  privateKey: Schema.String,
});
const decodeKeypair = Schema.decodeUnknownEffect(Schema.fromJsonString(VapidKeypair));

export const makeWebPushVapid = (
  config: WebPushConfig,
): Effect.Effect<WebPushVapidKeys, never, ServerSecretStore> =>
  Effect.gen(function* () {
    if (config.publicKeyOverride && config.privateKeyOverride) {
      return {
        publicKey: config.publicKeyOverride,
        privateKey: config.privateKeyOverride,
        subject: config.subject,
      };
    }

    const secrets = yield* ServerSecretStore;
    const existing = yield* secrets
      .get(SECRET_NAME)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isSome(existing)) {
      const decoded = yield* decodeKeypair(new TextDecoder().decode(existing.value)).pipe(
        Effect.map((k): { publicKey: string; privateKey: string } | null => k),
        Effect.orElseSucceed(() => null),
      );
      if (decoded) {
        return {
          publicKey: decoded.publicKey,
          privateKey: decoded.privateKey,
          subject: config.subject,
        };
      }
    }

    const generated = webpush.generateVAPIDKeys();
    yield* secrets
      .set(
        SECRET_NAME,
        new TextEncoder().encode(
          // @effect-diagnostics-next-line preferSchemaOverJson:off - persisting a small known keypair as a secret blob.
          JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey }),
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "t3x web-push: failed to persist VAPID keys; using an in-memory keypair for this session (existing browser subscriptions will need to re-register after restart)",
            { cause },
          ),
        ),
      );
    return {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      subject: config.subject,
    };
  });
