/*
 * T3 Code service worker — closed-tab Web Push only.
 *
 * Deliberately has NO `fetch` handler: this is not an offline/caching PWA, and
 * intercepting fetches would risk serving stale app assets. Its sole jobs are
 * to display push notifications when no tab is open and to focus/open the right
 * thread when one is clicked.
 *
 * De-duplication with the in-page NotificationCoordinator: if ANY T3 window is
 * open, that page owns notifications (it edge-detects the same transitions and
 * raises them itself, with per-thread suppression for the chat you're viewing).
 * So this worker only shows a notification when there is NO open tab — i.e. the
 * gap the in-page path cannot cover. This keeps notifications single-sourced
 * (never doubled) without any changes to the existing coordinator.
 */

self.addEventListener("install", () => {
  // Activate immediately so the first registration can receive pushes without a reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(showFromPush(event));
});

async function showFromPush(event) {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  // If a T3 tab is open, the in-page coordinator handles this transition.
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.length > 0) {
    return;
  }

  const title = typeof payload.title === "string" ? payload.title : "T3 Code";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.key === "string" ? payload.key : undefined;
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: Boolean(tag),
    icon: "/icon-192.png",
    badge: "/favicon-32x32.png",
    data: {
      environmentId: typeof payload.environmentId === "string" ? payload.environmentId : null,
      threadId: typeof payload.threadId === "string" ? payload.threadId : null,
    },
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(focusThread(event.notification.data || {}));
});

async function focusThread(data) {
  const hasTarget = typeof data.environmentId === "string" && typeof data.threadId === "string";
  const targetPath = hasTarget
    ? `/${encodeURIComponent(data.environmentId)}/${encodeURIComponent(data.threadId)}`
    : "/";

  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    // Reuse an existing tab: focus it, then steer it to the waiting thread.
    if ("focus" in client) {
      try {
        await client.focus();
        if (hasTarget && "navigate" in client) {
          await client.navigate(targetPath);
        }
      } catch {
        /* fall through to opening a new window */
      }
      return;
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(targetPath);
  }
}
