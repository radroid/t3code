import {
  currentAssetPlatform,
  findAssetForPlatform,
  SHORT_SHA_LENGTH,
  type UpdateAsset,
  type UpdateManifest,
} from "./manifest.ts";

/**
 * "Should this app act on this manifest?"
 *
 * Kept pure and separate from every I/O concern, because each rejection below corresponds to a
 * failure that is invisible when it goes wrong: an app that updates forever, an app that
 * downgrades itself, an app that reinstalls a build it is already running and reports success.
 */

/**
 * `resolveGitCommitHash` in `scripts/build-desktop-artifact.ts` returns this literal when git
 * fails during a build. It must never be treated as a commit hash — an app that believes its own
 * commit is "unknown" differs from every real manifest and would update on every payload, forever.
 */
export const UNKNOWN_COMMIT_HASH = "unknown";

export interface InstalledBuild {
  /** From `DesktopAppIdentity`. Absent for any build that has no embedded hash. */
  readonly commitHash: string | undefined;
  /** From the last manifest this app acted on. Absent on first run. */
  readonly buildNumber: number | undefined;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly isPackaged: boolean;
}

export type UpdateDecision =
  | { readonly kind: "act"; readonly asset: UpdateAsset }
  | { readonly kind: "skip"; readonly reason: UpdateSkipReason };

export type UpdateSkipReason =
  | "not-packaged"
  | "unknown-own-commit"
  | "unsupported-platform"
  | "already-running-this-build"
  | "not-newer"
  | "no-asset-for-platform";

export function describeSkipReason(reason: UpdateSkipReason): string {
  switch (reason) {
    case "not-packaged":
      return "Update delivery is only active in packaged builds.";
    case "unknown-own-commit":
      return "This build has no embedded commit hash, so it cannot tell whether an update applies.";
    case "unsupported-platform":
      return "No artifact is published for this platform and architecture.";
    case "already-running-this-build":
      return "This build is already running.";
    case "not-newer":
      return "The announced build is not newer than the one already staged or running.";
    case "no-asset-for-platform":
      return "The announced build has no artifact for this platform.";
  }
}

function normalizeCommitHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === UNKNOWN_COMMIT_HASH) return undefined;
  if (!/^[0-9a-f]{7,40}$/u.test(trimmed)) return undefined;
  return trimmed.slice(0, SHORT_SHA_LENGTH);
}

export function decideUpdateAction(
  manifest: UpdateManifest,
  installed: InstalledBuild,
): UpdateDecision {
  // A dev build has no meaningful identity and cannot be installed over. Checked first so the
  // reason surfaced is the true one rather than a downstream symptom.
  if (!installed.isPackaged) {
    return { kind: "skip", reason: "not-packaged" };
  }

  const ownHash = normalizeCommitHash(installed.commitHash);
  if (ownHash === undefined) {
    return { kind: "skip", reason: "unknown-own-commit" };
  }

  const platform = currentAssetPlatform(installed.platform, installed.arch);
  if (platform === undefined) {
    return { kind: "skip", reason: "unsupported-platform" };
  }

  // Before ordering, because reinstalling the build you are already running is the specific
  // failure issue #47 describes: it succeeds, reports success, and changes nothing.
  if (manifest.shortSha === ownHash) {
    return { kind: "skip", reason: "already-running-this-build" };
  }

  // Strictly greater. A manifest that is merely *different* is not necessarily newer: the release
  // matrix has two legs, and a slow Windows leg from an earlier run can be announced after a
  // later run. Acting on it would move this app backwards onto an older build while every
  // indicator says the update worked.
  if (installed.buildNumber !== undefined && manifest.buildNumber <= installed.buildNumber) {
    return { kind: "skip", reason: "not-newer" };
  }

  const asset = findAssetForPlatform(manifest, platform);
  if (asset === undefined) {
    return { kind: "skip", reason: "no-asset-for-platform" };
  }

  return { kind: "act", asset };
}
