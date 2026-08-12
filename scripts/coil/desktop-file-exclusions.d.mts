/*
 * Types for desktop-file-exclusions.mjs. Hand-written for the same reason as
 * windows-exit-codes.d.mts: the implementation is `.mjs` so the release workflow can run it on the
 * runner image's Node, and this package's tsconfig does not set `allowJs`.
 */

export const DESKTOP_FILE_EXCLUSIONS_ENV_NAME: string;

export const T3X_DESKTOP_FILE_EXCLUSIONS: readonly string[];

export const T3X_DESKTOP_FILE_EXCLUSION_GROUPS: {
  readonly thirdPartySourceMaps: readonly string[];
  readonly clerkBrowserSdk: readonly string[];
  readonly diffRenderer: readonly string[];
};

/** Throws when a glob contains the comma the environment variable uses as its separator. */
export function assertNoSeparatorInGlobs(globs: readonly string[]): void;

export function renderExclusionEnvValue(globs?: readonly string[]): string;
