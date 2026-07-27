import { useEffect } from "react";

import { isElectron } from "~/env";
import { useClientSettings } from "~/hooks/useSettings";
import { getNotificationPermissionState } from "~/notifications/notifier";
import { ensurePushSubscription, removePushSubscription } from "~/notifications/push";
import { pushServiceWorkerSupported } from "~/notifications/serviceWorker";

/**
 * Keeps this browser's Web Push subscription in sync with the notification setting +
 * permission, so the server can raise a notification when the tab is fully closed (the gap the
 * in-page `NotificationCoordinator` cannot cover).
 *
 * Renders nothing. Desktop (Electron) uses the OS notification bridge and never subscribes.
 * Subscribes when notifications are enabled AND permission is granted; unsubscribes when the
 * setting is turned off. Reacts to a permission grant that happens after mount via the
 * Permissions API `change` event, since permission state is otherwise non-reactive.
 */
export function PushSubscriptionManager() {
  const notifyOnNeedsInput = useClientSettings((settings) => settings.notifyOnNeedsInput);

  useEffect(() => {
    if (isElectron || !pushServiceWorkerSupported()) {
      return;
    }

    let cancelled = false;
    const sync = () => {
      if (cancelled) {
        return;
      }
      if (notifyOnNeedsInput && getNotificationPermissionState() === "granted") {
        void ensurePushSubscription();
      } else if (!notifyOnNeedsInput) {
        void removePushSubscription();
      }
    };

    sync();

    // Re-run when the user answers the permission prompt after mount (grant/deny).
    let permissionStatus: PermissionStatus | null = null;
    const permissions = navigator.permissions;
    if (permissions?.query) {
      permissions
        .query({ name: "notifications" as PermissionName })
        .then((status) => {
          if (cancelled) {
            return;
          }
          permissionStatus = status;
          status.addEventListener("change", sync);
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      permissionStatus?.removeEventListener("change", sync);
    };
  }, [notifyOnNeedsInput]);

  return null;
}
