import { describe, expect, it } from "vite-plus/test";

import {
  formatBuiltAgo,
  AUTO_RESTART_CEILING_MS,
  autoRestartExpired,
  countProgressingThreads,
  selectUpdateToastView,
  shouldArmAutoRestart,
  shouldAutoRestartNow,
  shouldSendRestart,
  type ProgressCandidateThread,
  type UpdateToastInput,
} from "./updateToast.logic.ts";

const ARMED_AT = 1_700_000_000_000;

function input(overrides: Partial<UpdateToastInput> = {}): UpdateToastInput {
  return {
    status: { kind: "ready", shortSha: "abc123def456", version: "0.0.31-coil.abc123def456" },
    dismissedShortSha: undefined,
    isElectron: true,
    platform: "MacIntel",
    hasUpdatedBefore: true,
    ...overrides,
  };
}

const WINDOWS = "Win32";

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
        status: { kind: "ready", shortSha: "ffffffffffff", version: "0.0.31-coil.ffffffffffff" },
        dismissedShortSha: "abc123def456",
      });
      expect(view.kind).toBe("ready");
    });
  });

  describe("the first-update App Management warning", () => {
    it("warns on the first update", () => {
      // The updater replaces the bundle in /Applications, and a self-signed build has no team
      // identifier for macOS to match, so App Management is raised once. The user needs to
      // recognise that dialog rather than read it as the update having gone wrong.
      const view = selectUpdateToastView(input({ hasUpdatedBefore: false }));
      expect(view.kind === "ready" && view.description).toContain("App Management");
    });

    it("quotes the dialog's own wording, so it is recognisable when it appears", () => {
      // The point of the note is recognition. Describing the prompt in our own words instead of
      // macOS's is what made the previous version useless: it promised "screen-recording and
      // automation", which is not what the dialog says and not a permission this app requests.
      const view = selectUpdateToastView(input({ hasUpdatedBefore: false }));
      expect(view.kind === "ready" && view.description).toContain("access to data from other apps");
    });

    it("does not claim the builds are unsigned", () => {
      // They have been signed since #70/PR #85. The reason for the prompt is the missing team
      // identifier, and saying "unsigned" sent a real diagnosis after the signature instead.
      const view = selectUpdateToastView(input({ hasUpdatedBefore: false }));
      expect(view.kind === "ready" && view.description).not.toContain("unsigned");
    });

    it("does not repeat it afterwards", () => {
      const view = selectUpdateToastView(input({ hasUpdatedBefore: true }));
      expect(view.kind === "ready" && view.description).not.toContain("App Management");
    });

    it("stays off Windows entirely, first update or not", () => {
      // App Management is a macOS concept. Windows was being promised a dialog its OS never shows.
      const view = selectUpdateToastView(input({ platform: WINDOWS, hasUpdatedBefore: false }));
      expect(view.kind === "ready" && view.description).not.toContain("App Management");
    });
  });

  describe("what the action actually does, per platform", () => {
    it("calls it a restart on macOS, because that is what it is", () => {
      // Delete then rename. Staging already paid for everything expensive.
      const view = selectUpdateToastView(input());
      expect(view.kind === "ready" && view.actionLabel).toBe("Restart");
      expect(view.kind === "ready" && view.autoRestartLabel).toBe("Restart when idle");
    });

    it("does not call it a restart on Windows, because it is not one", () => {
      // The click hands off to a silent NSIS installer and the app is gone for minutes. Labelling
      // that "Restart" is what made a normal install read as the app deleting itself.
      const view = selectUpdateToastView(input({ platform: WINDOWS }));
      expect(view.kind === "ready" && view.actionLabel).toBe("Install and reopen");
      expect(view.kind === "ready" && view.autoRestartLabel).toBe("Install when idle");
    });

    it("warns Windows that the app disappears and the shortcut breaks", () => {
      // Both symptoms are named because both were read as evidence of a destroyed install.
      const view = selectUpdateToastView(input({ platform: WINDOWS }));
      const description = view.kind === "ready" ? view.description : "";
      expect(description).toContain("a few minutes");
      expect(description).toContain("Start-menu shortcut");
    });

    it("leaves Linux on the neutral wording", () => {
      const view = selectUpdateToastView(input({ platform: "Linux x86_64" }));
      expect(view.kind === "ready" && view.actionLabel).toBe("Restart");
      expect(view.kind === "ready" && view.description).not.toContain("Start-menu");
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
          status: { kind: "failed", message: "Install failed.", logPath: "/tmp/coil-update.log" },
        }),
      );
      expect(view.kind === "failed" && view.description).toContain("/tmp/coil-update.log");
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

describe("the changelog-forward ready toast", () => {
  const ready = (extra: Record<string, unknown>) =>
    selectUpdateToastView(
      input({
        status: {
          kind: "ready",
          shortSha: "abc123def456",
          version: "0.0.31-coil.44",
          ...extra,
        } as UpdateToastInput["status"],
      }),
    );

  it("leads with the change count", () => {
    // "3 changes ready to run" answers the question a fork maintainer actually has.
    const view = ready({ changes: ["a", "b", "c"] });
    expect(view.kind === "ready" && view.title).toBe("3 changes ready to run");
  });

  it("does not say '1 changes'", () => {
    const view = ready({ changes: ["only one"] });
    expect(view.kind === "ready" && view.title).toBe("1 change ready to run");
  });

  it("falls back to the generic title rather than '0 changes'", () => {
    // The manifest does not carry subjects yet, and an older shell never will.
    const view = ready({});
    expect(view.kind === "ready" && view.title).toBe("Update ready");
    expect(view.kind === "ready" && view.changes).toEqual([]);
  });

  it("omits the age when the manifest omitted builtAt", () => {
    // Rendering "built undefined ago" is worse than rendering nothing.
    const view = ready({});
    expect(view.kind === "ready" && view.builtAgo).toBeUndefined();
    expect(view.kind === "ready" && view.runUrl).toBeUndefined();
  });

  it("formats the age when builtAt is present", () => {
    const now = Date.parse("2026-08-08T12:00:00.000Z");
    const view = selectUpdateToastView(
      input({
        status: {
          kind: "ready",
          shortSha: "abc123def456",
          version: "0.0.31-coil.44",
          builtAt: "2026-08-08T11:56:00.000Z",
        },
        now,
      }),
    );
    expect(view.kind === "ready" && view.builtAgo).toBe("4 min ago");
  });
});

describe("formatBuiltAgo", () => {
  const at = (iso: string) => Date.parse(iso);
  const BUILT = "2026-08-08T12:00:00.000Z";

  it.each([
    ["just now", "2026-08-08T12:00:30.000Z"],
    ["1 min ago", "2026-08-08T12:01:00.000Z"],
    ["59 min ago", "2026-08-08T12:59:00.000Z"],
    ["1h ago", "2026-08-08T13:00:00.000Z"],
    ["2d ago", "2026-08-10T12:00:00.000Z"],
  ])("renders %s", (expected, now) => {
    expect(formatBuiltAgo(BUILT, at(now))).toBe(expected);
  });

  it("clamps clock skew rather than saying 'in 3 minutes'", () => {
    // The builder's clock can run ahead of this machine's. A future age reads as an app bug.
    expect(formatBuiltAgo(BUILT, at("2026-08-08T11:57:00.000Z"))).toBe("just now");
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(formatBuiltAgo("not-a-date", at(BUILT))).toBeUndefined();
  });
});

describe("countProgressingThreads", () => {
  const thread = (over: Partial<ProgressCandidateThread> = {}): ProgressCandidateThread => ({
    environmentId: "local",
    latestTurn: { state: "running" },
    archivedAt: null,
    settledOverride: null,
    ...over,
  });

  it("counts a running turn in the primary environment", () => {
    expect(countProgressingThreads([thread()], "local")).toBe(1);
  });

  it("ignores finished turns", () => {
    expect(countProgressingThreads([thread({ latestTurn: { state: "completed" } })], "local")).toBe(
      0,
    );
  });

  it("ignores threads that never ran", () => {
    expect(countProgressingThreads([thread({ latestTurn: null })], "local")).toBe(0);
  });

  it("does not let a remote environment block the restart", () => {
    // Restarting the desktop app tears down the server it hosts. A thread running on a remote
    // environment survives that, so blocking on it would wait for something never at risk.
    expect(countProgressingThreads([thread({ environmentId: "remote-box" })], "local")).toBe(0);
  });

  it("ignores archived threads", () => {
    // A thread put away should not hold the app hostage because its last turn was never marked
    // finished — which is exactly the crash-frozen `running` case.
    expect(countProgressingThreads([thread({ archivedAt: "2026-08-01T00:00:00Z" })], "local")).toBe(
      0,
    );
  });

  it("ignores threads the user explicitly settled", () => {
    expect(countProgressingThreads([thread({ settledOverride: "settled" })], "local")).toBe(0);
  });

  it("reports idle when there is no primary environment", () => {
    expect(countProgressingThreads([thread()], null)).toBe(0);
  });

  it("sums across threads", () => {
    expect(
      countProgressingThreads(
        [thread(), thread(), thread({ latestTurn: { state: "completed" } })],
        "local",
      ),
    ).toBe(2);
  });
});

describe("restart when idle", () => {
  const armed = { armedAt: ARMED_AT };

  it("offers the arm control alongside an immediate restart", () => {
    const view = selectUpdateToastView(input());
    expect(view.kind === "ready" && view.autoRestartLabel).toBe("Restart when idle");
    expect(view.kind === "ready" && view.actionLabel).toBe("Restart");
  });

  it("stays visible while armed", () => {
    // An armed restart that hides is indistinguishable from one that never fires. The user has
    // handed over control of when the app disappears; the least it can do is say so.
    const view = selectUpdateToastView(input({ autoRestart: armed, now: ARMED_AT + 60_000 }));
    expect(view.kind).toBe("armed");
    expect(view.kind === "armed" && view.description).toContain("keep working");
  });

  it("keeps an immediate restart available while armed", () => {
    // Arming is a preference, not a lock-in.
    const view = selectUpdateToastView(input({ autoRestart: armed, now: ARMED_AT + 60_000 }));
    expect(view.kind === "armed" && view.actionLabel).toBe("Restart now");
    expect(shouldSendRestart(view)).toBe(true);
  });

  it("cannot be armed twice", () => {
    const view = selectUpdateToastView(input({ autoRestart: armed, now: ARMED_AT + 60_000 }));
    expect(shouldArmAutoRestart(view)).toBe(false);
  });

  describe("the ceiling", () => {
    it("falls back to prompting rather than waiting forever", () => {
      // Turns wedge in `running` — "reconcile crash-frozen `running` turns" has landed here more
      // than once. Waiting forever is #41's silence with extra steps.
      const view = selectUpdateToastView(
        input({ autoRestart: armed, now: ARMED_AT + AUTO_RESTART_CEILING_MS }),
      );
      expect(view.kind).toBe("ready");
      expect(view.kind === "ready" && view.autoRestartTimedOut).toBe(true);
    });

    it("explains why it is asking again", () => {
      // A bare re-prompt reads as a bug to someone who explicitly asked not to be interrupted.
      const view = selectUpdateToastView(
        input({ autoRestart: armed, now: ARMED_AT + AUTO_RESTART_CEILING_MS }),
      );
      expect(view.kind === "ready" && view.description).toContain("stood down");
    });

    it("does not fire the restart once expired", () => {
      // Standing down must not become "restart under the user anyway" — something is still running.
      expect(
        shouldAutoRestartNow({
          armed,
          progressingThreadCount: 0,
          now: ARMED_AT + AUTO_RESTART_CEILING_MS,
        }),
      ).toBe(false);
    });

    it("is not expired one millisecond early", () => {
      expect(autoRestartExpired(armed, ARMED_AT + AUTO_RESTART_CEILING_MS - 1)).toBe(false);
    });
  });

  describe("shouldAutoRestartNow", () => {
    it("fires only once nothing is running", () => {
      expect(shouldAutoRestartNow({ armed, progressingThreadCount: 0, now: ARMED_AT + 1000 })).toBe(
        true,
      );
    });

    it("waits while any thread is still working", () => {
      expect(shouldAutoRestartNow({ armed, progressingThreadCount: 1, now: ARMED_AT + 1000 })).toBe(
        false,
      );
    });

    it("never fires when nothing was armed", () => {
      expect(
        shouldAutoRestartNow({ armed: undefined, progressingThreadCount: 0, now: ARMED_AT }),
      ).toBe(false);
    });
  });

  it("hides an armed toast the user dismissed for that build", () => {
    const view = selectUpdateToastView(
      input({ autoRestart: armed, now: ARMED_AT + 1000, dismissedShortSha: "abc123def456" }),
    );
    expect(view.kind).toBe("hidden");
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

describe("the boot after an install", () => {
  const FAILED = {
    kind: "install-failed",
    expectedShortSha: "b23e83fa0258",
    expectedVersion: "0.0.31-coil.7",
    actualShortSha: "dd90bbace7c3",
    actualVersion: "0.0.31-coil.6",
    platform: "win32",
    arch: "x64",
  } as const;

  it("confirms a successful update once", () => {
    const view = selectUpdateToastView(
      input({ status: { kind: "updated", shortSha: "b23e83fa0258", version: "0.0.31-coil.7" } }),
    );
    expect(view.kind).toBe("updated");
    expect(view.kind === "updated" && view.title).toContain("0.0.31-coil.7");
  });

  it("says the old version still works, so a failure does not read as a broken install", () => {
    // The Windows failure mode is the app vanishing for minutes. If it comes back and reports a
    // failure without saying the previous build survived, that reads as data loss.
    const view = selectUpdateToastView(input({ status: FAILED }));
    expect(view.kind).toBe("install-failed");
    expect(view.kind === "install-failed" && view.description).toContain("still works");
  });

  it("offers a pre-filled report carrying both sides of the comparison", () => {
    const view = selectUpdateToastView(input({ status: FAILED }));
    if (view.kind !== "install-failed") throw new Error("expected install-failed");

    const url = new URL(view.reportUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/radroid/t3code/issues/new");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("b23e83fa0258");
    expect(body).toContain("dd90bbace7c3");
    expect(url.searchParams.get("title")).toContain("b23e83fa0258");
  });

  it("keeps machine-identifying detail out of a public repo", () => {
    // Build identity only. Paths are where usernames leak, and none are needed to identify the
    // build that failed.
    const view = selectUpdateToastView(input({ status: FAILED }));
    if (view.kind !== "install-failed") throw new Error("expected install-failed");
    const body = new URL(view.reportUrl).searchParams.get("body") ?? "";
    expect(body).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it("still reports when the running build has no commit hash at all", () => {
    // `actualShortSha` absent is not a reason to stay quiet — it is a build worth reporting.
    // The key is omitted rather than set to `undefined`: the contract marks it optional, and
    // `exactOptionalPropertyTypes` treats those as different things.
    const { actualShortSha: _omitted, ...withoutHash } = FAILED;
    const view = selectUpdateToastView(input({ status: withoutHash }));
    if (view.kind !== "install-failed") throw new Error("expected install-failed");
    expect(view.description).toContain("no commit");
    expect(new URL(view.reportUrl).searchParams.get("body")).toContain("none reported");
  });
});
