/*
 * Types for desktop-bundle-reachability.mjs. Hand-written for the same reason as
 * windows-exit-codes.d.mts: the implementation is `.mjs` so the release workflow can run it on the
 * runner image's Node, and this package's tsconfig does not set `allowJs`.
 */

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly bytes: number;
  readonly files: number;
}

/** How the closure first arrived at a package. See the module header on why `mention` exists. */
export type ReachedVia = "import" | "mention";

export interface Reached {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly via: ReachedVia;
  /** The package, or entry directory, that named it. */
  readonly from: string;
}

export const DEFAULT_ENTRY_DIRS: readonly string[];

export function packageNameFromSpecifier(specifier: string): string | undefined;

export function collectSpecifiers(source: string): {
  readonly imports: Set<string>;
  readonly mentions: Set<string>;
  readonly dynamicSites: number;
};

/** Replaces comment bytes with spaces, preserving every character offset and line break. */
export function blankComments(source: string): string;

export function resolvePackageDir(
  fromDir: string,
  name: string,
  rootDir: string,
): string | undefined;

export function collectInstalledPackages(rootDir: string): Map<string, InstalledPackage>;

export function computeReachablePackages(
  rootDir: string,
  entryDirs: readonly string[],
): {
  readonly reachable: Map<string, Reached>;
  readonly dynamicSites: number;
  readonly entryFiles: number;
};

export function analyzeStage(
  rootDir: string,
  entryDirs: readonly string[],
): {
  readonly installed: Map<string, InstalledPackage>;
  readonly reachable: Map<string, Reached>;
  readonly unreachable: readonly InstalledPackage[];
  readonly mentionOnly: readonly (InstalledPackage & { readonly from: string })[];
  readonly dynamicSites: number;
  readonly entryFiles: number;
  readonly totalBytes: number;
  readonly unreachableBytes: number;
};
