import type { DesktopBridge } from "@t3tools/contracts";

import type { AttentionEvent } from "./needsAttention.logic";
import type { WebNotificationPermission } from "./notifier.logic";

export { canDeliverNotification, type WebNotificationPermission } from "./notifier.logic";

type NotificationCapableBridge = DesktopBridge & {
  readonly showNotification: NonNullable<DesktopBridge["showNotification"]>;
};

/**
 * The desktop shell only when it can actually raise notifications: an older
 * shell hosting a newer web bundle exposes a bridge without these members, and
 * must fall back to the renderer's own Notification API.
 */
function notificationBridge(): NotificationCapableBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridge = window.desktopBridge;
  return bridge?.showNotification ? (bridge as NotificationCapableBridge) : null;
}

function webNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Desktop reports `"granted"` outright: the OS owns that permission and the
 * shell never routes through the Web Notification API.
 */
export function getNotificationPermissionState(): WebNotificationPermission {
  if (notificationBridge()) {
    return "granted";
  }
  if (!webNotificationSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

export async function requestWebNotificationPermission(): Promise<WebNotificationPermission> {
  if (notificationBridge()) {
    return "granted";
  }
  if (!webNotificationSupported()) {
    return "unsupported";
  }
  return await Notification.requestPermission();
}

/**
 * Raises one attention notification on whichever surface is available.
 *
 * On desktop the click travels back over IPC instead of `onActivate`, so the
 * caller must also subscribe to `onNotificationActivated`. On the web path the
 * event key doubles as the notification tag, which lets the browser coalesce
 * repeat notifications for the same thread.
 */
export function showAttentionNotification(
  event: AttentionEvent,
  onActivate: (activation: { readonly environmentId: string; readonly threadId: string }) => void,
): void {
  const bridge = notificationBridge();
  if (bridge) {
    void bridge
      .showNotification({
        id: event.key,
        title: event.title,
        body: event.body,
        environmentId: event.environmentId,
        threadId: event.threadId,
      })
      .catch(() => undefined);
    return;
  }

  if (!webNotificationSupported()) {
    return;
  }

  // Android Chrome reports `"Notification" in window` and can even report
  // permission `"granted"`, yet throws `TypeError: Illegal constructor` here
  // because page-scope notifications need a service worker. Swallow it: the
  // throw would otherwise escape the coordinator's effect, tearing down the
  // React tree and dropping the rest of the event batch.
  let notification: Notification;
  try {
    notification = new Notification(event.title, { body: event.body, tag: event.key });
  } catch {
    return;
  }

  notification.addEventListener("click", () => {
    window.focus();
    onActivate({ environmentId: event.environmentId, threadId: event.threadId });
    notification.close();
  });
}
