/**
 * Notification permission as seen by the app, which spans two platforms: a
 * desktop shell that owns the OS-level permission itself, and browsers whose
 * Notification API may be absent entirely (`"unsupported"`).
 */
export type WebNotificationPermission = "unsupported" | "default" | "granted" | "denied";

/**
 * Both gates must be open: the user opted in, and the platform will actually
 * raise the notification. Anything else stays silent.
 */
export function canDeliverNotification(
  permission: WebNotificationPermission,
  enabled: boolean,
): boolean {
  return enabled && permission === "granted";
}
