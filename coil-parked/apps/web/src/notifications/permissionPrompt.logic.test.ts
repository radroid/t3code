import { describe, expect, it } from "vite-plus/test";

import type { WebNotificationPermission } from "./notifier.logic";
import { shouldShowPermissionPrompt } from "./permissionPrompt.logic";

const PROMPTABLE = {
  state: { promptedThisSession: false },
  settingEnabled: true,
  permission: "default" as WebNotificationPermission,
  isElectron: false,
} as const;

describe("shouldShowPermissionPrompt", () => {
  it("prompts a web user who left the setting on but never answered the browser", () => {
    expect(shouldShowPermissionPrompt(PROMPTABLE)).toBe(true);
  });

  it("stays silent once this session already prompted", () => {
    expect(
      shouldShowPermissionPrompt({ ...PROMPTABLE, state: { promptedThisSession: true } }),
    ).toBe(false);
  });

  it("stays silent while the setting is off", () => {
    expect(shouldShowPermissionPrompt({ ...PROMPTABLE, settingEnabled: false })).toBe(false);
  });

  it("stays silent on desktop, where the OS owns the permission", () => {
    expect(shouldShowPermissionPrompt({ ...PROMPTABLE, isElectron: true })).toBe(false);
  });

  it("stays silent for every permission other than an unanswered one", () => {
    const otherPermissions: ReadonlyArray<WebNotificationPermission> = [
      "granted",
      "denied",
      "unsupported",
    ];
    for (const permission of otherPermissions) {
      expect(shouldShowPermissionPrompt({ ...PROMPTABLE, permission })).toBe(false);
    }
  });
});
