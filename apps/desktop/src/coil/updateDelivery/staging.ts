/**
 * Rules for the staging directory: what to write, what to keep, what to delete.
 *
 * Pure, because each rule prevents a state that looks fine. A truncated download that survives a
 * crash presents as a ready update. An unswept staging directory fills the disk at ~470 MB per
 * merge to `main`. Neither announces itself.
 */

/** A macOS dmg is ~250 MB and the unpacked bundle roughly doubles it. */
export const MIN_FREE_BYTES_HEADROOM = 1_500_000_000;

export interface StagedEntry {
  readonly name: string;
  /**
   * Absent when the filename carries no recognisable build. Those are always swept: an entry the
   * naming scheme does not explain is junk from an older layout or a partial write, and keeping it
   * would mean the staging directory grows by 470 MB per unrecognised file forever.
   */
  readonly shortSha: string | undefined;
  readonly bytes?: number;
}

/**
 * Downloads land on `<name>.part` and are renamed only after the checksum passes.
 *
 * Rename is atomic within a filesystem, so a crash at any point leaves either a `.part` file —
 * which is never treated as ready — or a complete, verified artifact. Writing directly to the
 * final name would leave a truncated file that passes an existence check and fails at install.
 */
export function partialDownloadName(finalName: string): string {
  return `${finalName}.part`;
}

export function isPartialDownload(name: string): boolean {
  return name.endsWith(".part");
}

export type DiskCheck =
  | { readonly kind: "sufficient" }
  | { readonly kind: "insufficient"; readonly requiredBytes: number; readonly freeBytes: number };

/**
 * Refuse to start a download that cannot finish.
 *
 * Headroom on top of the artifact size, because the download is not the peak: the dmg is mounted
 * and copied to a full second bundle beside the target. Filling the user's disk to deliver an
 * update they did not ask for yet is a bad trade, and this machine already runs at 95 percent.
 */
export function checkDiskSpace(args: {
  readonly assetBytes: number;
  readonly freeBytes: number;
}): DiskCheck {
  const requiredBytes = args.assetBytes + MIN_FREE_BYTES_HEADROOM;
  return args.freeBytes >= requiredBytes
    ? { kind: "sufficient" }
    : { kind: "insufficient", requiredBytes, freeBytes: args.freeBytes };
}

/**
 * Everything in the staging directory that is not the current target.
 *
 * Runs on startup as well as after a successful install, because the case that matters is the one
 * where no install ever completed: the app crashed, or the user quit mid-stage, and nothing ran
 * the cleanup path. `T3X_AUTOBUILD_KEEP_DMGS` exists in the shell installer for the same reason.
 *
 * Partial downloads are always swept, including one for the current target — a `.part` file from a
 * previous run cannot be resumed, because its bytes were never checksummed.
 */
export function selectStagingSweep(args: {
  readonly entries: readonly StagedEntry[];
  readonly targetShortSha: string | undefined;
}): readonly StagedEntry[] {
  return args.entries.filter((entry) => {
    if (isPartialDownload(entry.name)) return true;
    if (args.targetShortSha === undefined) return true;
    return entry.shortSha !== args.targetShortSha;
  });
}

export type ChecksumVerdict =
  | { readonly kind: "match" }
  | { readonly kind: "mismatch"; readonly expected: string; readonly actual: string };

/** Case-insensitive: `shasum` and `certutil` disagree on hex case. */
export function verifyChecksum(expected: string, actual: string): ChecksumVerdict {
  return expected.toLowerCase() === actual.toLowerCase()
    ? { kind: "match" }
    : { kind: "mismatch", expected: expected.toLowerCase(), actual: actual.toLowerCase() };
}

export type StagingProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "downloading"; readonly shortSha: string; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: "verifying"; readonly shortSha: string }
  | { readonly kind: "unpacking"; readonly shortSha: string }
  | { readonly kind: "ready"; readonly shortSha: string };

/**
 * Whether an in-flight staging run should be abandoned for a newly announced build.
 *
 * Never run two downloads at once, and never finish staging a build that is already superseded —
 * a `ready` state pointing at an older build than the one just announced would offer the user a
 * restart that immediately puts them behind again.
 */
export function shouldAbandonStaging(args: {
  readonly inFlightShortSha: string;
  readonly announcedShortSha: string;
}): boolean {
  return args.inFlightShortSha !== args.announcedShortSha;
}
