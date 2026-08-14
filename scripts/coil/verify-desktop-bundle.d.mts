/*
 * Types for verify-desktop-bundle.mjs. Hand-written for the same reason as
 * windows-exit-codes.d.mts: the implementation is `.mjs` so the release workflow can run it on the
 * runner image's Node, and this package's tsconfig does not set `allowJs`.
 */

export interface PackagedFile {
  readonly size: number;
  readonly read: () => Buffer;
}

export interface PackagePresence {
  readonly present: boolean;
  readonly manifest: boolean;
  readonly loadableFiles: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  /**
   * Imported by a packaged bundle and not loadable from the shipped app. Every entry fails the release;
   * `glob` only says whether the fork's own exclusion list can be named as the cause.
   */
  readonly missing: readonly {
    readonly name: string;
    readonly importedBy: string;
    readonly glob: string | undefined;
  }[];
  /** Sibling `server.asar` sidecars merged into the view (the Windows server tree since #102). */
  readonly sidecars: readonly string[];
  /**
   * FIRST_PARTY_BUNDLE_DIRS entries that contributed no scanned bundle in any packaged layer.
   * Non-empty fails the release: a layer the checker cannot see must not pass silently.
   */
  readonly uncoveredBundleDirs: readonly string[];
  readonly totalBytes: number;
  readonly totalFiles: number;
  readonly mapBytes: number;
}

export const FIRST_PARTY_BUNDLE_DIRS: readonly string[];

export function readAsarFiles(asarPath: string): Map<string, PackagedFile>;

export function readUnpackedFiles(unpackedDir: string): Map<string, PackagedFile>;

/** The shipped app as one view, merging the archive with its `app.asar.unpacked` sibling. */
export function readPackagedFiles(asarPath: string): Map<string, PackagedFile>;

export function isPackagedSpecifier(specifier: string): boolean;

export function collectRequiredPackages(files: Map<string, PackagedFile>): Map<string, string>;

export function inspectPackagePresence(
  files: Map<string, PackagedFile>,
  name: string,
): PackagePresence;

export function findExcludingGlob(name: string, globs?: readonly string[]): string | undefined;

export function verifyPackagedApp(asarPath: string): VerifyResult;

export function findAsarInAppDir(appDir: string): string | undefined;
