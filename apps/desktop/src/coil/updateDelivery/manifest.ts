import * as Schema from "effect/Schema";

/**
 * The update manifest, as published by `.github/workflows/coil-release.yml` and rebroadcast
 * verbatim by the relay.
 *
 * The relay does not understand this shape — it parses `buildNumber` for ordering and treats
 * everything else as opaque. That means this file is the *only* definition of the contract, and
 * adding a field here never requires a relay deploy.
 */

/** Matches `COMMIT_HASH_DISPLAY_LENGTH` in `DesktopAppIdentity.ts`. */
export const SHORT_SHA_LENGTH = 12;

const ShortSha = Schema.String.check(
  Schema.isPattern(new RegExp(`^[0-9a-f]{${SHORT_SHA_LENGTH}}$`, "u")),
);

export const UpdateAssetPlatform = Schema.Literals(["darwin-arm64", "win32-x64"]);
export type UpdateAssetPlatform = typeof UpdateAssetPlatform.Type;

export const UpdateAsset = Schema.Struct({
  platform: UpdateAssetPlatform,
  file: Schema.String,
  url: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type UpdateAsset = typeof UpdateAsset.Type;

export const UpdateManifest = Schema.Struct({
  /**
   * The comparison key, and the only one.
   *
   * 12 characters because that is what the app can read about itself: the build script writes
   * `t3codeCommitHash` from `git rev-parse --short=12`, and `DesktopAppIdentity` truncates to
   * `COMMIT_HASH_DISPLAY_LENGTH`. A 40-char key here would never compare equal to anything the
   * app knows, so the app would offer the same update forever — including immediately after
   * installing it.
   */
  shortSha: ShortSha,
  /**
   * The ordering key. Sourced from the release workflow's run number.
   *
   * Separate from the commit on purpose. A hash cannot express "newer", and on this fork it
   * especially cannot: `main` is force-pushed by the sync playbook, so a released commit may not
   * even be an ancestor of `main` and ancestry answers nothing.
   */
  buildNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Display and traceability only. Never compared. */
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  version: Schema.String,
  releaseTag: Schema.String,
  builtAt: Schema.String,
  /**
   * Commit subjects in this build, newest first.
   *
   * `optionalKey`, and it must stay that way: a client running this build can be offered a
   * manifest published *before* the field existed, and a required field would fail the decode —
   * which this pipeline treats as "no update", silently withholding a real one. The same reason
   * `runUrl` is optional.
   */
  changes: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The workflow run that produced this build. Built from `run_id`, never `run_number`. */
  runUrl: Schema.optionalKey(Schema.String),
  assets: Schema.Array(UpdateAsset).check(Schema.isMinLength(1)),
});
export type UpdateManifest = typeof UpdateManifest.Type;

export const decodeUpdateManifest = Schema.decodeUnknownEffect(UpdateManifest);
export const decodeUpdateManifestJson = Schema.decodeEffect(Schema.fromJsonString(UpdateManifest));

export function findAssetForPlatform(
  manifest: UpdateManifest,
  platform: UpdateAssetPlatform,
): UpdateAsset | undefined {
  return manifest.assets.find((asset) => asset.platform === platform);
}

/**
 * Maps the running process to a manifest platform key.
 *
 * Returns undefined for anything v1 does not publish — Linux, Windows arm64, Intel macs. The
 * caller must treat that as "this feature does not apply here", never as an error, so an
 * unsupported platform simply never sees a toast.
 */
export function currentAssetPlatform(
  platform: NodeJS.Platform,
  arch: string,
): UpdateAssetPlatform | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return undefined;
}
