import { describe, expect, it } from "vite-plus/test";

import { decideUpdateAction, type InstalledBuild } from "./decision.ts";
import type { UpdateManifest } from "./manifest.ts";

const MANIFEST: UpdateManifest = {
  shortSha: "ffffffffffff",
  buildNumber: 20,
  sha: "f".repeat(40),
  version: "0.0.31-t3x.ffffffffffff",
  releaseTag: "t3x-build-ffffffffffff",
  builtAt: "2026-08-03T12:00:00.000Z",
  assets: [
    {
      platform: "darwin-arm64",
      file: "T3Code-ffffffffffff-arm64.dmg",
      url: "https://example.invalid/arm64.dmg",
      sha256: "a".repeat(64),
      bytes: 248_000_000,
    },
    {
      platform: "win32-x64",
      file: "T3Code-ffffffffffff-x64.exe",
      url: "https://example.invalid/x64.exe",
      sha256: "b".repeat(64),
      bytes: 190_000_000,
    },
  ],
};

const INSTALLED: InstalledBuild = {
  commitHash: "aaaaaaaaaaaa",
  buildNumber: 19,
  platform: "darwin",
  arch: "arm64",
  isPackaged: true,
};

function installed(overrides: Partial<InstalledBuild> = {}): InstalledBuild {
  return { ...INSTALLED, ...overrides };
}

describe("decideUpdateAction", () => {
  it("acts on a newer build with a matching asset", () => {
    const decision = decideUpdateAction(MANIFEST, installed());
    expect(decision.kind).toBe("act");
    expect(decision.kind === "act" && decision.asset.platform).toBe("darwin-arm64");
  });

  it("picks the asset for the running platform", () => {
    const decision = decideUpdateAction(MANIFEST, installed({ platform: "win32", arch: "x64" }));
    expect(decision.kind === "act" && decision.asset.platform).toBe("win32-x64");
  });

  it("refuses to act when this build carries no release counter", () => {
    // Changed deliberately on 2026-08-07; it previously acted. `buildNumber` comes from the app's
    // own version, and only `t3x-release.yml` writes `-t3x.<n>` — so `undefined` does not mean
    // "first run", it means "this app was built locally". Treating that as "no floor" let a
    // locally built app install ANY announced release over itself, including one cut from an
    // OLDER commit than the one it was built from: a silent downgrade that reports success.
    const decision = decideUpdateAction(MANIFEST, installed({ buildNumber: undefined }));
    expect(decision).toEqual({ kind: "skip", reason: "unknown-own-build-number" });
  });

  it("still acts on the first RELEASED build, which always carries a counter", () => {
    // The case the old test was reaching for. A released build's own version supplies the floor,
    // so a newer release is accepted without needing any stored history.
    const decision = decideUpdateAction(MANIFEST, installed({ buildNumber: 19 }));
    expect(decision.kind).toBe("act");
  });

  it("skips a build this app is already running", () => {
    // Issue #47's core hazard: reinstalling the running build succeeds and changes nothing, which
    // is indistinguishable from a real update unless it is refused up front.
    const decision = decideUpdateAction(MANIFEST, installed({ commitHash: "ffffffffffff" }));
    expect(decision).toEqual({ kind: "skip", reason: "already-running-this-build" });
  });

  it("skips a build that is already running even when its buildNumber is higher", () => {
    // A rebuild of the same commit. Different run number, identical content — restarting for it
    // would be a no-op the user was asked to approve.
    const decision = decideUpdateAction(
      { ...MANIFEST, buildNumber: 999 },
      installed({ commitHash: "ffffffffffff" }),
    );
    expect(decision).toEqual({ kind: "skip", reason: "already-running-this-build" });
  });

  it("skips an older build rather than downgrading", () => {
    // The out-of-order case: a slow Windows leg from run 19 announced after run 25 has landed.
    // "Different from mine" would accept it and quietly move the user backwards.
    const decision = decideUpdateAction({ ...MANIFEST, buildNumber: 19 }, installed({ buildNumber: 25 }));
    expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
  });

  it("skips a re-announcement of the build already staged", () => {
    const decision = decideUpdateAction(MANIFEST, installed({ buildNumber: 20 }));
    expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
  });

  describe("own-commit trust", () => {
    it.each([
      ["the literal 'unknown' the build script emits on git failure", "unknown"],
      ["an absent hash", undefined],
      ["an empty hash", ""],
      ["a non-hex hash", "zzzzzzzzzzzz"],
    ])("refuses to act when its own commit is %s", (_label, commitHash) => {
      // Any of these would otherwise compare unequal to every manifest forever, so the app would
      // offer an update on every single payload — including right after installing one.
      const decision = decideUpdateAction(MANIFEST, installed({ commitHash }));
      expect(decision).toEqual({ kind: "skip", reason: "unknown-own-commit" });
    });

    it("accepts a full 40-char hash by comparing its 12-char prefix", () => {
      const decision = decideUpdateAction(MANIFEST, installed({ commitHash: "f".repeat(40) }));
      expect(decision).toEqual({ kind: "skip", reason: "already-running-this-build" });
    });

    it("is case-insensitive about its own hash", () => {
      const decision = decideUpdateAction(MANIFEST, installed({ commitHash: "FFFFFFFFFFFF" }));
      expect(decision).toEqual({ kind: "skip", reason: "already-running-this-build" });
    });
  });

  it("does nothing in an unpackaged dev build", () => {
    const decision = decideUpdateAction(MANIFEST, installed({ isPackaged: false }));
    expect(decision).toEqual({ kind: "skip", reason: "not-packaged" });
  });

  it.each([
    ["Intel macOS", "darwin" as NodeJS.Platform, "x64"],
    ["Linux", "linux" as NodeJS.Platform, "x64"],
    ["Windows arm64", "win32" as NodeJS.Platform, "arm64"],
  ])("stays silent on %s, which v1 does not publish", (_label, platform, arch) => {
    const decision = decideUpdateAction(MANIFEST, installed({ platform, arch }));
    expect(decision).toEqual({ kind: "skip", reason: "unsupported-platform" });
  });

  it("skips when the manifest carries no asset for this platform", () => {
    const macOnly: UpdateManifest = {
      ...MANIFEST,
      assets: MANIFEST.assets.filter((asset) => asset.platform === "darwin-arm64"),
    };
    const decision = decideUpdateAction(macOnly, installed({ platform: "win32", arch: "x64" }));
    expect(decision).toEqual({ kind: "skip", reason: "no-asset-for-platform" });
  });
});
