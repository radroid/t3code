import type { WebNotificationPermission } from "./notifier.logic";

/**
 * Session-scoped memory of the contextual permission nudge, so a browser that
 * never answers the permission dialog is asked at most once per page load.
 */
export interface PermissionPromptState {
  readonly promptedThisSession: boolean;
}

/**
 * Only an unanswered browser permission is worth nudging about: `"denied"` and
 * `"unsupported"` cannot be recovered from in-page, `"granted"` needs nothing,
 * and the desktop shell never routes through the Web Notification API at all.
 */
export function shouldShowPermissionPrompt(args: {
  readonly state: PermissionPromptState;
  readonly settingEnabled: boolean;
  readonly permission: WebNotificationPermission;
  readonly isElectron: boolean;
}): boolean {
  return (
    args.settingEnabled &&
    args.permission === "default" &&
    !args.isElectron &&
    !args.state.promptedThisSession
  );
}
