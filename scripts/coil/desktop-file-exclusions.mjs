/*
 * Globs the fork adds to electron-builder's `files`, passed by env so upstream's pinned list and
 * its test stay untouched (docs/coil/SEAMS.md). A wrong entry ships MODULE_NOT_FOUND: each must be
 * unreachable per desktop-bundle-reachability.mjs, re-checked every release. Keep out
 * playwright-core, undici and `@msgpackr-extract/*`, which are loaded by runtime-built paths.
 */

import * as NodeURL from "node:url";

/**
 * Third-party source maps (~18 MiB). Node reads `.map` only under `--enable-source-maps`, which the
 * desktop backend never sets. First-party maps live outside `node_modules` and are deliberately
 * kept, so an operator who enables source maps still gets legible frames for our code.
 */
const THIRD_PARTY_SOURCE_MAPS = ["!**/node_modules/**/*.map"];

/**
 * Clerk's browser SDK tree (~23 MiB). The main process only requires `@clerk/electron`'s root and
 * `/storage`; `/react` and `/passkeys` are used by the already-bundled, sandboxed web renderer.
 * `@clerk/electron`, `@clerk/electron-passkeys` and its native binaries must stay: they are
 * required or staged by `stageClerkPasskeyNativeBinaries()`.
 */
const CLERK_BROWSER_SDK = [
  "!**/node_modules/@clerk/clerk-js/**/*",
  "!**/node_modules/@clerk/react/**/*",
  "!**/node_modules/@clerk/shared/**/*",
  "!**/node_modules/@stripe/stripe-js/**/*",
  "!**/node_modules/@swc/helpers/**/*",
  "!**/node_modules/@tanstack/query-core/**/*",
  "!**/node_modules/@zxcvbn-ts/core/**/*",
  "!**/node_modules/@zxcvbn-ts/language-common/**/*",
  "!**/node_modules/alien-signals/**/*",
  "!**/node_modules/browser-tabs-lock/**/*",
  "!**/node_modules/core-js/**/*",
  "!**/node_modules/crypto-js/**/*",
  "!**/node_modules/fastest-levenshtein/**/*",
  "!**/node_modules/glob-to-regexp/**/*",
  "!**/node_modules/js-cookie/**/*",
  "!**/node_modules/lodash/**/*",
];

/**
 * The diff renderer and its syntax-highlighting tree (~21 MiB). The server bundles its one
 * `@pierre/diffs` subpath into `bin.mjs` and the web client ships its own grammar chunks, so this
 * copy is unloadable. The unified/hast long tail is reached only through `@pierre/diffs`.
 */
const DIFF_RENDERER = [
  "!**/node_modules/@pierre/diffs/**/*",
  "!**/node_modules/@pierre/theme/**/*",
  "!**/node_modules/@pierre/theming/**/*",
  "!**/node_modules/@shikijs/core/**/*",
  "!**/node_modules/@shikijs/engine-javascript/**/*",
  "!**/node_modules/@shikijs/engine-oniguruma/**/*",
  "!**/node_modules/@shikijs/langs/**/*",
  "!**/node_modules/@shikijs/primitive/**/*",
  "!**/node_modules/@shikijs/themes/**/*",
  "!**/node_modules/@shikijs/transformers/**/*",
  "!**/node_modules/@shikijs/types/**/*",
  "!**/node_modules/@shikijs/vscode-textmate/**/*",
  "!**/node_modules/@types/hast/**/*",
  "!**/node_modules/@types/mdast/**/*",
  "!**/node_modules/@types/unist/**/*",
  "!**/node_modules/@ungap/structured-clone/**/*",
  "!**/node_modules/ccount/**/*",
  "!**/node_modules/character-entities-html4/**/*",
  "!**/node_modules/character-entities-legacy/**/*",
  "!**/node_modules/comma-separated-tokens/**/*",
  "!**/node_modules/devlop/**/*",
  "!**/node_modules/diff/**/*",
  "!**/node_modules/hast-util-to-html/**/*",
  "!**/node_modules/hast-util-whitespace/**/*",
  "!**/node_modules/html-void-elements/**/*",
  "!**/node_modules/lru_map/**/*",
  "!**/node_modules/mdast-util-to-hast/**/*",
  "!**/node_modules/micromark-util-character/**/*",
  "!**/node_modules/micromark-util-encode/**/*",
  "!**/node_modules/micromark-util-sanitize-uri/**/*",
  "!**/node_modules/micromark-util-symbol/**/*",
  "!**/node_modules/micromark-util-types/**/*",
  "!**/node_modules/oniguruma-parser/**/*",
  "!**/node_modules/oniguruma-to-es/**/*",
  "!**/node_modules/property-information/**/*",
  "!**/node_modules/regex/**/*",
  "!**/node_modules/regex-recursion/**/*",
  "!**/node_modules/regex-utilities/**/*",
  "!**/node_modules/shiki/**/*",
  "!**/node_modules/space-separated-tokens/**/*",
  "!**/node_modules/stringify-entities/**/*",
  "!**/node_modules/trim-lines/**/*",
  "!**/node_modules/unist-util-is/**/*",
  "!**/node_modules/unist-util-position/**/*",
  "!**/node_modules/unist-util-stringify-position/**/*",
  "!**/node_modules/unist-util-visit/**/*",
  "!**/node_modules/unist-util-visit-parents/**/*",
  "!**/node_modules/vfile/**/*",
  "!**/node_modules/vfile-message/**/*",
  "!**/node_modules/zwitch/**/*",
];

/**
 * Read by `scripts/build-desktop-artifact.ts`; comma-separated, so `assertNoSeparatorInGlobs()`
 * rejects brace groups. Never export it into a shell that runs tests: upstream's test pins
 * `DESKTOP_FILE_EXCLUSIONS` to its one entry, so the release workflow scopes it to one step.
 */
export const DESKTOP_FILE_EXCLUSIONS_ENV_NAME = "T3X_DESKTOP_FILE_EXCLUSIONS";

/** Every glob the fork adds, in the order the groups are documented above. */
export const T3X_DESKTOP_FILE_EXCLUSIONS = [
  ...THIRD_PARTY_SOURCE_MAPS,
  ...CLERK_BROWSER_SDK,
  ...DIFF_RENDERER,
];

/**
 * The groups, kept addressable so the tests can assert about them by name rather than by index.
 */
export const T3X_DESKTOP_FILE_EXCLUSION_GROUPS = {
  thirdPartySourceMaps: THIRD_PARTY_SOURCE_MAPS,
  clerkBrowserSdk: CLERK_BROWSER_SDK,
  diffRenderer: DIFF_RENDERER,
};

/**
 * @param {readonly string[]} globs
 * @throws {Error} when a glob contains the separator used to pass the list through the environment.
 */
export function assertNoSeparatorInGlobs(globs) {
  const offenders = globs.filter((glob) => glob.includes(","));
  if (offenders.length > 0) {
    throw new Error(
      `${DESKTOP_FILE_EXCLUSIONS_ENV_NAME} is comma-separated, so these globs cannot be passed through it: ${offenders.join(" ")}`,
    );
  }
}

/**
 * @param {readonly string[]} [globs]
 * @returns {string} The value to export as T3X_DESKTOP_FILE_EXCLUSIONS.
 */
export function renderExclusionEnvValue(globs = T3X_DESKTOP_FILE_EXCLUSIONS) {
  assertNoSeparatorInGlobs(globs);
  return globs.join(",");
}

/**
 * Whether this module was run directly, rather than imported. Comparing against
 * `file://${process.argv[1]}` never matches on Windows (native `D:\` path), so the CLI silently did
 * nothing and exited 0. `pathToFileURL` is correct on every platform.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === NodeURL.pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.stdout.write(renderExclusionEnvValue());
}
