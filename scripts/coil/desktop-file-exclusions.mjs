/*
 * The globs the fork adds to electron-builder's `files` when packaging a desktop release.
 *
 * Issue #53. Measured against the first fully green release build, the packaged `app.asar` was
 * 189.66 MiB across 14,765 files. Roughly half of that could not be loaded by anything:
 *
 *   - 37.4 MiB of source maps for the web renderer (handled elsewhere — see T3CODE_WEB_SOURCEMAP in
 *     .github/workflows/coil-release.yml; no glob can fix it because the maps are first-party output).
 *   - 18.2 MiB of source maps belonging to third-party packages.
 *   - 44.2 MiB of packages that exist only to be *bundled* by a client build, and so leave nothing
 *     behind for Node to resolve at runtime.
 *
 * WHY THIS FILE IS NOT IN `build-desktop-artifact.ts`. That file is upstream-owned and hot (180
 * commits in the 60 days before the 2026-08-10 merge-base). Its test asserts
 * `deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, ["!**\/node_modules/@anthropic-ai/claude-agent-sdk-*\/**\/*"])`,
 * so any entry added to that array in place has to be added to that assertion too.
 *
 * The reason that matters is NOT the row count. `build-desktop-artifact.test.ts` already carries a fork
 * row from the #71 rename, so growing it would not add a new one. The reason is that this list is 67
 * globs and will grow: inline, every future size fix becomes an edit to an upstream TEST assertion —
 * a file resolved by hand at every sync, where a conflict is decided by re-reading 67 lines instead of
 * one. Through the environment, an unset environment packages exactly what upstream packages, upstream's
 * assertion keeps passing untouched, and the list stays here where it is fork-owned, commented, and
 * unit-tested. The same answer #70 reached for the same file. See docs/coil/SEAMS.md.
 *
 * THE STANDARD OF EVIDENCE. Getting one of these wrong ships MODULE_NOT_FOUND to users on a code
 * path that may not run until someone signs in, so nothing is on this list because it "looked
 * unused". Every entry satisfies both of:
 *
 *   1. `scripts/coil/desktop-bundle-reachability.mjs` cannot reach it from the built bundles — by a
 *      literal `require()`/`import` specifier OR by any string literal naming the package (the
 *      second edge is what keeps `playwright-core` out of this list; read that file's header).
 *   2. Removing the tree's root from the dependency graph orphans it — so there is no second path
 *      into the bundle that a future upstream change could leave behind.
 *
 * `scripts/coil/verify-desktop-bundle.mjs` re-checks (1) against the packed artifact on every
 * release, on both platforms, before anything is published. A glob that starts removing something
 * real fails the release rather than shipping.
 *
 * DELIBERATELY NOT HERE, so the next reader does not re-derive it:
 *
 *   - `playwright-core` (10.2 MiB). Loaded at runtime by
 *     `apps/desktop/src/preview/PlaywrightInjectedRuntime.ts` via `require.resolve()` on a `const`.
 *     Reachable only by string mention, which is exactly why that edge type exists.
 *   - `undici` (1.6 MiB). Nothing reaches it, but Node's own `fetch` machinery and several HTTP
 *     clients probe for it dynamically. 1.6 MiB is not worth a networking bug.
 *   - `@msgpackr-extract/*` native accelerators. `node-gyp-build` loads them by assembling a path at
 *     runtime — the one blind spot the reachability closure admits to having.
 *   - `react-grab` and its CLI tree (~2 MiB, ~25 packages). Bundled into `preview-pick-preload.cjs`
 *     and unreachable, so it is a legitimate candidate; it is left out only because the remaining
 *     win is small next to the number of globs it costs. Cutting it would also delete every package
 *     named in this issue's "genuine duplicate installs" section (`onetime`, `mimic-fn`,
 *     `restore-cursor`), making that section moot without touching `pnpm.overrides`.
 */

import * as NodeURL from "node:url";

/**
 * Third-party source maps: 18.2 MiB across ~2,290 files, and not one of them is read at runtime.
 *
 * Node only parses a `.map` when `--enable-source-maps` is set, and the desktop backend passes
 * NODE_OPTIONS through rather than setting it (`DesktopBackendConfiguration.ts`), so a shipped build
 * never asks for these. First-party maps are deliberately NOT matched by this glob: `bin.mjs.map`
 * and `main.cjs.map` live outside `node_modules` and are what make a user's stack trace readable, so
 * an operator who does export `NODE_OPTIONS=--enable-source-maps` still gets legible frames for our
 * own code.
 */
const THIRD_PARTY_SOURCE_MAPS = ["!**/node_modules/**/*.map"];

/**
 * Clerk's browser SDK and everything it alone pulls in: 23.2 MiB across 6,722 files.
 *
 * `@clerk/clerk-js` reaches the production graph through `@clerk/electron`, which the desktop main
 * process does depend on. But the main process requires exactly two of that package's six entry
 * points — the root and `/storage` — and between them they require only `electron` and
 * `electron-store`. The entries that pull the browser SDK are `/react` and `/passkeys`, and the only
 * importer of those is `apps/web/src/main.tsx`.
 *
 * `apps/web` is compiled to `apps/server/dist/client/assets/*.js` before the artifact is staged, so
 * those imports are already inlined; and the renderer that runs them is created with
 * `sandbox: true, nodeIntegration: false` in `apps/desktop/src/window/DesktopWindow.ts`, so it has
 * no module resolution at all. Nothing that runs can reach these files. (Clerk's own
 * `loadClerkJsScript` builds a jsDelivr URL for the browser bundle, which is a network fetch, not a
 * `node_modules` lookup.)
 *
 * `@clerk/electron`, `@clerk/electron-passkeys` and its native `*-darwin-arm64` /
 * `*-win32-x64-msvc` binaries are all absent from this list on purpose: the first is required by the
 * main process, and the others are staged deliberately by `stageClerkPasskeyNativeBinaries()`.
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
 * The diff renderer and its syntax-highlighting tree: 21.0 MiB across 2,944 files.
 *
 * `@pierre/diffs` is a production dependency of `apps/server`, which is why the whole tree installs,
 * but the server imports exactly one subpath — `@pierre/diffs/utils/parsePatchFiles`, in
 * `apps/server/src/checkpointing/Diffs.ts` — and the server build *bundles* it: `bin.mjs` contains
 * the inlined helpers and has no `@pierre/*` import left. Tree-shaking means the shiki half never
 * makes it into the bundle either.
 *
 * The syntax highlighting a user actually sees is the web client's own per-language chunks
 * (`apps/server/dist/client/assets/typescript-*.js` and friends), built from the same grammars. So
 * `@shikijs/langs` was being shipped twice, and this is the copy nobody could load. That was the
 * open question in issue #53 §3.3; this is the answer.
 *
 * The long tail (`unist-*`, `micromark-*`, `hast-*`, `character-entities-*`) is the unified/hast
 * pipeline underneath `hast-util-to-html`, reached only through `@pierre/diffs`. Small individually,
 * but they are most of the file count, and file count is what asar packing and dmg/nsis compression
 * actually cost.
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
 * The environment variable `scripts/build-desktop-artifact.ts` reads. Comma-separated, which is why
 * `assertNoSeparatorInGlobs()` exists: a `{a,b}` brace group would be split down the middle and
 * silently become two globs that match nothing.
 *
 * DO NOT export this variable into a shell you then run tests in. Upstream's
 * `build-desktop-artifact.test.ts` asserts `DESKTOP_FILE_EXCLUSIONS` deep-equals exactly its one
 * entry, so with this set that test fails with an unhelpful 68-vs-1 array diff. That assertion is the
 * whole reason the seam is an environment hook rather than an edited literal, so the constraint is
 * load-bearing rather than an accident. The release workflow scopes the variable to the single build
 * step for this reason (a step output, not $GITHUB_ENV). Since #92 retired the local autobuild, that
 * workflow is the only path that builds a shipping artifact.
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
 * Whether this module was run directly, rather than imported.
 *
 * `import.meta.url === `file://${process.argv[1]}`` is the idiom this replaces, and it is broken on
 * Windows. `process.argv[1]` is a native path there (`D:\a\...`), so the template produces
 * `file://D:\a\...` while `import.meta.url` is `file:///D:/a/...` — drive letter after three
 * slashes, forward separators. They never match, so a Windows CLI run silently executed nothing,
 * exited 0, and printed no output.
 *
 * That is how it reached production: on macOS and Linux the idiom works, because an absolute POSIX
 * path already begins with `/`. Both CI callers of these scripts are `set -euo pipefail`, and
 * neither could see the difference between "verified" and "did nothing" — one release failed on the
 * empty stdout, the other passed a check that had not run. `pathToFileURL` is what Node provides for
 * exactly this, and it is correct on every platform.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === NodeURL.pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.stdout.write(renderExclusionEnvValue());
}
