/**
 * Pure, platform-agnostic helpers for Web Push subscription. Kept free of any
 * `navigator`/`PushManager` calls so they are unit-testable without a DOM.
 */

export interface SerializedPushSubscription {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

/**
 * Converts a URL-safe base64 VAPID public key into the `Uint8Array` that
 * `PushManager.subscribe` expects as `applicationServerKey`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/**
 * Normalises a `PushSubscription.toJSON()` payload into the exact shape the
 * server stores. Returns null when the browser handed back an incomplete
 * subscription (no endpoint or missing keys), which callers treat as "cannot
 * register" rather than sending a useless row to the server.
 */
export function serializePushSubscription(
  subscription: PushSubscriptionJSON,
): SerializedPushSubscription | null {
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys?.p256dh;
  const auth = subscription.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}
