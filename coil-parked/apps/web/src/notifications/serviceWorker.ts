import { isElectron } from "~/env";

const SERVICE_WORKER_URL = "/sw.js";

/**
 * Closed-tab push needs a service worker + PushManager on a secure origin.
 * The desktop shell (Electron) raises notifications through its OS bridge and
 * never registers this worker.
 */
export function pushServiceWorkerSupported(): boolean {
  return (
    !isElectron &&
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext
  );
}

/** Registers the push service worker at root scope, or returns null when unsupported. */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushServiceWorkerSupported()) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  } catch {
    return null;
  }
}
