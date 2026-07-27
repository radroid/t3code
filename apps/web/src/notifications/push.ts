/**
 * Web Push client orchestration: register the service worker, subscribe with the server's
 * VAPID key, and register/unregister the subscription with the server.
 *
 * The server routes are raw `/api/t3x/push/*` routes, so they are called exactly like
 * `AutoResumeOverlay` calls `/api/t3x/auto-resume`: over `primaryEnvironmentHttpLayer`, the one
 * place in the web app that authenticates the primary environment (session cookies for a
 * same-origin browser, desktop bearer token otherwise). Every failure is swallowed to null/false
 * — push is an enhancement and must never surface an error into the app.
 *
 * @module notifications/push
 */

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { primaryEnvironmentHttpLayer } from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

import { serializePushSubscription, urlBase64ToUint8Array } from "./push.logic";
import { pushServiceWorkerSupported, registerPushServiceWorker } from "./serviceWorker";

const VAPID_KEY_PATH = "/api/t3x/push/vapid-public-key";
const SUBSCRIBE_PATH = "/api/t3x/push/subscribe";
const UNSUBSCRIBE_PATH = "/api/t3x/push/unsubscribe";

const pushRuntime = ManagedRuntime.make(primaryEnvironmentHttpLayer);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchVapidPublicKey(): Promise<string | null> {
  const url = resolvePrimaryEnvironmentHttpUrl(VAPID_KEY_PATH);
  try {
    return await pushRuntime.runPromise(
      Effect.gen(function* () {
        const response = yield* HttpClient.get(url);
        if (response.status !== 200) {
          return null;
        }
        const body = yield* response.json;
        const publicKey = isRecord(body) ? body.publicKey : undefined;
        return typeof publicKey === "string" && publicKey !== "" ? publicKey : null;
      }),
    );
  } catch {
    return null;
  }
}

async function postJson(path: string, body: unknown): Promise<boolean> {
  const url = resolvePrimaryEnvironmentHttpUrl(path);
  try {
    return await pushRuntime.runPromise(
      Effect.gen(function* () {
        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
        );
        return response.status === 200;
      }),
    );
  } catch {
    return false;
  }
}

/** True when an existing subscription was created with the current server VAPID key. */
function applicationServerKeyMatches(
  subscription: PushSubscription,
  expected: Uint8Array,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) {
    return false;
  }
  const currentBytes = new Uint8Array(current);
  if (currentBytes.length !== expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (currentBytes[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Idempotently ensures this browser has a push subscription registered with the server.
 * Safe to call repeatedly (on mount, on setting/permission change): it reuses an existing
 * browser subscription when its key still matches the server's, otherwise re-subscribes (the
 * server's VAPID key can change, which permanently breaks the old subscription).
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!pushServiceWorkerSupported()) {
    return;
  }
  const registration = await registerPushServiceWorker();
  if (!registration) {
    return;
  }

  const vapidPublicKey = await fetchVapidPublicKey();
  if (!vapidPublicKey) {
    return;
  }
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    if (applicationServerKeyMatches(existing, applicationServerKey)) {
      const serialized = serializePushSubscription(existing.toJSON());
      if (serialized) {
        await postJson(SUBSCRIBE_PATH, serialized);
      }
      return;
    }
    // Server VAPID key changed: the old subscription can never be delivered to. Drop it and
    // fall through to re-subscribe with the current key.
    try {
      await existing.unsubscribe();
    } catch {
      /* best effort */
    }
  }

  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as BufferSource,
    });
  } catch {
    return;
  }

  const serialized = serializePushSubscription(subscription.toJSON());
  if (!serialized) {
    return;
  }
  const ok = await postJson(SUBSCRIBE_PATH, serialized);
  if (!ok) {
    // The server would not store it, so don't leave a browser subscription the server can
    // never push to; drop it so a later retry starts clean.
    try {
      await subscription.unsubscribe();
    } catch {
      /* best effort */
    }
  }
}

/** Removes this browser's push subscription locally and on the server (best effort). */
export async function removePushSubscription(): Promise<void> {
  if (!pushServiceWorkerSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    return;
  }
  const existing = await registration.pushManager.getSubscription();
  if (!existing) {
    return;
  }
  const endpoint = existing.endpoint;
  try {
    await existing.unsubscribe();
  } catch {
    /* best effort */
  }
  await postJson(UNSUBSCRIBE_PATH, { endpoint });
}
