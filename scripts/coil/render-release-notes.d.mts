/*
 * Types for render-release-notes.mjs.
 *
 * Hand-written because the implementation is `.mjs` (see the header comment there — the publish
 * job runs on the runner image's Node, with no `setup-node` step, so it must not depend on type
 * stripping) and this package's tsconfig does not set `allowJs`. Without this file the test
 * imports it as `any` and `tsgo --noEmit` fails on the implicit type.
 *
 * These shapes describe scripts/coil/install-instructions.json.
 */

export interface InstallStep {
  readonly title: string;
  readonly body: string;
  /** `null` when the step is something to do rather than something to run. */
  readonly command: string | null;
  readonly shell: string | null;
}

export interface InstallPlatform {
  readonly id: string;
  readonly name: string;
  readonly support: string;
  /** Matches the `platform` field of an asset in `t3x-latest.json`. */
  readonly assetPlatform: string;
  readonly exampleFile: string;
  readonly steps: readonly InstallStep[];
  readonly afterword: string;
}

export interface InstallInstructions {
  readonly appBundleName: string;
  readonly appBundleNameOrigin: string;
  readonly downloadPageUrl: string;
  readonly platforms: readonly InstallPlatform[];
  readonly unsignedNote: string;
}

export const REPO_ROOT: string;

export function loadInstructions(repoRoot: string): InstallInstructions;

export function desktopProductName(repoRoot: string): string;

export function fillCommand(
  template: string,
  values: { readonly app: string; readonly file: string },
): string;

export function assetFileName(
  platform: { readonly assetPlatform: string },
  shortSha: string,
): string;

export function renderReleaseNotes(input: {
  readonly instructions: InstallInstructions;
  readonly sha: string;
  readonly shortSha: string;
}): string;
