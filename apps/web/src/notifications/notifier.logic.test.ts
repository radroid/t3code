import { describe, expect, it } from "vite-plus/test";

import { canDeliverNotification, type WebNotificationPermission } from "./notifier.logic";

const PERMISSIONS: ReadonlyArray<WebNotificationPermission> = [
  "unsupported",
  "default",
  "granted",
  "denied",
];

describe("canDeliverNotification", () => {
  it("delivers only when granted and the setting is enabled", () => {
    expect(canDeliverNotification("granted", true)).toBe(true);
  });

  it("never delivers while the setting is off", () => {
    for (const permission of PERMISSIONS) {
      expect(canDeliverNotification(permission, false)).toBe(false);
    }
  });

  it("never delivers without granted permission", () => {
    for (const permission of PERMISSIONS.filter((value) => value !== "granted")) {
      expect(canDeliverNotification(permission, true)).toBe(false);
    }
  });
});
