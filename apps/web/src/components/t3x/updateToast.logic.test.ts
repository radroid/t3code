import { describe, expect, it } from "vite-plus/test";

import {
  selectUpdateToastView,
  shouldSendRestart,
  type UpdateToastInput,
} from "./updateToast.logic.ts";

function input(overrides: Partial<UpdateToastInput> = {}): UpdateToastInput {
  return {
    status: { kind: "ready", shortSha: "abc123def456", version: "0.0.31-t3x.abc123def456" },
    dismissedShortSha: undefined,
    isElectron: true,
    hasUpdatedBefore: true,
    ...overrides,
  };
}

describe("selectUpdateToastView", () => {
  it("offers a restart once a build is staged", () => {
    const view = selectUpdateToastView(input());
    expect(view.kind).toBe("ready");
    expect(view.kind === "ready" && view.actionLabel).toBe("Restart");
  });

  it("stays hidden in a browser", () => {
    // There is no bundle to swap outside Electron.
    expect(selectUpdateToastView(input({ isElectron: false })).kind).toBe("hidden");
  });

  it("stays hidden while staging", () => {
    // Staging is background work the user cannot act on. Surfacing it trains people to dismiss
    // the toast without reading it, which costs us the one moment we actually need their
    // attention.
    const view = selectUpdateToastView(
      input({ status: { kind: "staging", shortSha: "abc123def456" } }),
    );
    expect(view.kind).toBe("hidden");
  });

  it("stays hidden when idle", () => {
    expect(selectUpdateToastView(input({ status: { kind: "idle" } })).kind).toBe("hidden");
  });

  describe("dismissal", () => {
    it("hides a build the user dismissed", () => {
      const view = selectUpdateToastView(input({ dismissedShortSha: "abc123def456" }));
      expect(view.kind).toBe("hidden");
    });

    it("still shows the NEXT build after a dismissal", () => {
      // Dismissal is per-build. A global "dismissed" flag would let one click silently opt the
      // user out of every future update.
      const view = selectUpdateToastView({
        ...input(),
        status: { kind: "ready", shortSha: "ffffffffffff", version: "0.0.31-t3x.ffffffffffff" },
        dismissedShortSha: "abc123def456",
      });
      expect(view.kind).toBe("ready");
    });
  });

  describe("the unsigned-build permission warning", () => {
    it("warns on the first update", () => {
      // TCC authorises on code-signing identity, and ad-hoc signatures change every build, so
      // grants reset on every update. The user needs to understand that once.
      const view = selectUpdateToastView(input({ hasUpdatedBefore: false }));
      expect(view.kind === "ready" && view.description).toContain("permissions again");
    });

    it("does not repeat it afterwards", () => {
      const view = selectUpdateToastView(input({ hasUpdatedBefore: true }));
      expect(view.kind === "ready" && view.description).not.toContain("permissions again");
    });
  });

  it("shows progress while restarting", () => {
    const view = selectUpdateToastView(input({ status: { kind: "restarting" } }));
    expect(view.kind).toBe("restarting");
  });

  describe("failure", () => {
    it("is never silent", () => {
      // The other half of #41: the 103-minute outage was invisible because the failing path had
      // no way to speak.
      const view = selectUpdateToastView(
        input({ status: { kind: "failed", message: "Could not replace the app bundle." } }),
      );
      expect(view.kind).toBe("failed");
      expect(view.kind === "failed" && view.description).toContain("Could not replace");
    });

    it("includes the log path when there is one", () => {
      const view = selectUpdateToastView(
        input({
          status: { kind: "failed", message: "Install failed.", logPath: "/tmp/t3x-update.log" },
        }),
      );
      expect(view.kind === "failed" && view.description).toContain("/tmp/t3x-update.log");
    });

    it("is shown even when the user dismissed the ready toast for that build", () => {
      const view = selectUpdateToastView(
        input({
          status: { kind: "failed", message: "Install failed." },
          dismissedShortSha: "abc123def456",
        }),
      );
      expect(view.kind).toBe("failed");
    });
  });
});

describe("shouldSendRestart", () => {
  it("forwards a click from the ready state", () => {
    expect(shouldSendRestart(selectUpdateToastView(input()))).toBe(true);
  });

  it.each([
    ["hidden", { kind: "idle" as const }],
    ["restarting", { kind: "restarting" as const }],
  ])("ignores a click in the %s state", (_label, status) => {
    // Two windows each render this toast, so a second click can arrive while the first restart is
    // already in flight.
    expect(shouldSendRestart(selectUpdateToastView(input({ status })))).toBe(false);
  });
});
