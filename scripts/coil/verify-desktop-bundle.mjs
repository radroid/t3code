/*
 * Fails a release whose packaged app is missing a package its own bundles require.
 *
 * Issue #53. The fork excludes roughly half the asar (see scripts/coil/desktop-file-exclusions.mjs),
 * and the failure mode of getting one of those globs wrong is the worst kind: a MODULE_NOT_FOUND
 * thrown by a shipped app, on a code path that may not run until a user signs in, days after the
 * release went green. Every fork seam gets a compensating control that a sync cannot quietly defeat —
 * this is that control for the packaging seam, and it is deliberately the same shape as
 * verify-mac-signature.ts: a step that reads the artifact about to be published and refuses it,
 * rather than a test that reads the source that produced it.
 *
 * WHAT IT CHECKS. Every bare module specifier imported by the packaged first-party bundles
 * (`apps/desktop/dist-electron/*.cjs`, `apps/server/dist/**`) must still resolve to a package with
 * loadable files in the shipped app. Package-level granularity is not a shortcut — it is exactly the
 * granularity of the risk, because every fork exclusion removes a whole package or a file type,
 * never an individual entry point.
 *
 * EVERY LAYER OF THE APP, WHICH IS THE POINT ON WINDOWS. The Windows artifact ships the server tree
 * as a separate `resources/server.asar` sidecar (plus its `.unpacked` sibling for natives) so the
 * NSIS installer extracts a handful of archives instead of thousands of files; `app.asar` holds only
 * the Electron main-process bundle. A checker that read only `app.asar` would verify a fraction of
 * the app and could not fail on the rest — which happened: the 2026-08-14 sync imported that split
 * and this gate red-flagged `node-pty` as unresolvable when it had merely moved into the sidecar
 * (issue #102). So the view merges `app.asar`, `app.asar.unpacked/`, and any sibling `server.asar`
 * (+ `.unpacked`) before anything is checked, and additionally requires that every entry in
 * FIRST_PARTY_BUNDLE_DIRS contributed at least one scanned bundle — a layer this checker cannot see
 * fails the release instead of silently passing it.
 *
 * ANY MISSING IMPORT FAILS, and an earlier draft of this file got that wrong in a way worth recording.
 * It split findings into "a fork glob removed this" (error) and "missing for some other reason"
 * (warning), reasoning that the fork should not fail releases over pre-existing gaps. A negative test —
 * building with a deliberately over-broad `!**\/node_modules/effect/**\/*` — went green: `effect` was
 * correctly detected as missing, but attribution compares against the exclusion list in
 * desktop-file-exclusions.mjs, and the bad glob had been injected through the environment instead. It
 * was filed as "pre-existing" and the release passed with a bundle that cannot start.
 *
 * The lesson is that attribution is a property of the *message*, not of the *severity*. A packaged app
 * that imports a package it does not contain is broken whoever broke it, so every one of them fails the
 * release; `findExcludingGlob()` only decides whether the error can name the glob to fix. The
 * false-positive class that motivated the split is handled where it belongs, by blanking comments below.
 *
 * WHAT IT DOES NOT CHECK. A package present but whose specific subpath was excluded, and a specifier
 * assembled at runtime from pieces that never appear whole. The first cannot happen while every fork
 * glob is whole-package or `*.map`; the second is the reachability closure's known blind spot,
 * documented in desktop-bundle-reachability.mjs.
 *
 * `.mjs` for the same reason as its siblings here: CI runs it on the runner image's Node, with no
 * `setup-node` step in front of it.
 */

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

import {
  blankComments,
  collectSpecifiers,
  packageNameFromSpecifier,
} from "./desktop-bundle-reachability.mjs";
import { T3X_DESKTOP_FILE_EXCLUSIONS } from "./desktop-file-exclusions.mjs";

/** Directories holding first-party bundles the app loads through Node. */
export const FIRST_PARTY_BUNDLE_DIRS = ["apps/desktop/dist-electron", "apps/server/dist"];

/**
 * Specifiers that must NOT be looked for in the package.
 *
 * `electron` is synthesized by the runtime. The `@t3tools/*` workspace packages are bundled into the
 * artifacts that reference them (`alwaysBundle` in apps/desktop/vite.config.ts), so a leftover string
 * naming one is not a resolution.
 */
const RUNTIME_PROVIDED = new Set(["electron"]);
const BUNDLED_WORKSPACE_PREFIXES = ["@t3tools/"];

/**
 * @typedef {object} PackagedFile
 * @property {number} size
 * @property {() => Buffer} read
 */

/**
 * Parses an asar into a path -> file view. An asar is a 16-byte pickle preamble, a JSON directory
 * listing, then concatenated contents; the listing is all this needs, so there is no extraction step
 * and no @electron/asar dependency.
 *
 * @param {string} asarPath
 * @returns {Map<string, PackagedFile>}
 */
export function readAsarFiles(asarPath) {
  const preamble = Buffer.alloc(16);
  const probe = NodeFS.openSync(asarPath, "r");
  let jsonSize;
  let contentOffset;
  let header;
  try {
    if (NodeFS.readSync(probe, preamble, 0, 16, 0) !== 16) {
      throw new Error(`${asarPath} is too short to be an asar archive.`);
    }
    jsonSize = preamble.readUInt32LE(12);
    if (jsonSize <= 0 || jsonSize > 256 * 1024 * 1024) {
      throw new Error(`${asarPath} declares an implausible header size (${jsonSize} bytes).`);
    }
    // File offsets are relative to the end of the header pickle, which is `8 + <the size stored in
    // the leading size pickle>`. Deriving it from the JSON length instead means re-deriving pickle's
    // 4-byte padding rule, and getting that wrong reads misaligned bytes that still parse as
    // plausible JavaScript.
    contentOffset = 8 + preamble.readUInt32LE(4);
    const jsonBuffer = Buffer.alloc(jsonSize);
    NodeFS.readSync(probe, jsonBuffer, 0, jsonSize, 16);
    // The header is NUL-padded to a 4-byte boundary, which JSON.parse will not accept. Cut at the
    // first NUL rather than regex-trimming the tail: a file name cannot contain one, so in a
    // well-formed header the first NUL is always the start of the padding — and it keeps a control
    // character out of a regular expression.
    const headerText = jsonBuffer.toString("utf8");
    const paddingStart = headerText.indexOf("\u0000");
    header = JSON.parse(paddingStart === -1 ? headerText : headerText.slice(0, paddingStart));
  } finally {
    NodeFS.closeSync(probe);
  }

  /** @type {Map<string, PackagedFile>} */
  const files = new Map();
  /**
   * @param {Record<string, any>} node
   * @param {string} prefix
   */
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        walk(child, full);
        continue;
      }
      const size = child.size ?? 0;
      // `unpacked: true` entries are listed in the header but their bytes live in
      // app.asar.unpacked/. Skipping them here is safe because readUnpackedFiles() adds them back
      // from disk; counting them from the archive would read another file's bytes.
      if (child.unpacked === true) continue;
      const offset = child.offset === undefined ? undefined : Number(child.offset);
      files.set(full, {
        size,
        read: () => {
          if (offset === undefined || size === 0) return Buffer.alloc(0);
          const handle = NodeFS.openSync(asarPath, "r");
          try {
            const buffer = Buffer.alloc(size);
            NodeFS.readSync(handle, buffer, 0, size, contentOffset + offset);
            return buffer;
          } finally {
            NodeFS.closeSync(handle);
          }
        },
      });
    }
  };
  walk(header, "");
  return files;
}

/**
 * @param {string} unpackedDir
 * @returns {Map<string, PackagedFile>}
 */
export function readUnpackedFiles(unpackedDir) {
  /** @type {Map<string, PackagedFile>} */
  const files = new Map();
  if (!NodeFS.existsSync(unpackedDir)) return files;

  /** @type {string[]} */
  const stack = [unpackedDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = NodePath.relative(unpackedDir, full).split(NodePath.sep).join("/");
      let size = 0;
      try {
        size = NodeFS.statSync(full).size;
      } catch {
        continue;
      }
      files.set(relative, { size, read: () => NodeFS.readFileSync(full) });
    }
  }
  return files;
}

/**
 * The shipped app as one path -> file map, however electron-builder chose to split it.
 *
 * @param {string} asarPath
 * @returns {Map<string, PackagedFile>}
 */
export function readPackagedFiles(asarPath) {
  const files = readAsarFiles(asarPath);
  for (const [relative, file] of readUnpackedFiles(`${asarPath}.unpacked`)) {
    files.set(relative, file);
  }
  return files;
}

/**
 * @param {string} specifier
 * @returns {boolean} Whether this specifier is expected to resolve inside the package at all.
 */
export function isPackagedSpecifier(specifier) {
  const name = packageNameFromSpecifier(specifier);
  if (name === undefined) return false;
  if (RUNTIME_PROVIDED.has(name)) return false;
  return !BUNDLED_WORKSPACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The packages the packaged first-party bundles import, with the bundle that imports each.
 *
 * Only `import` edges count, not the string-mention edges the reachability closure also follows. A
 * mention is evidence for *keeping* a package; it is not evidence that its absence breaks anything,
 * and treating it as such would fail on every package name that appears in an error message.
 *
 * Comments are blanked first. Without that, `@noble/hashes`'s bundled JSDoc — which contains
 * `* import { hmac } from '@noble/hashes/hmac';` inside an `@example` — reads as a real import of a
 * package that was never installed, and the gate fails a perfectly good build.
 *
 * @param {Map<string, PackagedFile>} files
 * @returns {Map<string, string>} package name -> first bundle path that imports it
 */
export function collectRequiredPackages(files) {
  /** @type {Map<string, string>} */
  const required = new Map();
  for (const [filePath, file] of files) {
    if (!FIRST_PARTY_BUNDLE_DIRS.some((dir) => filePath.startsWith(`${dir}/`))) continue;
    if (![".js", ".mjs", ".cjs"].includes(NodePath.posix.extname(filePath))) continue;
    if (file.size === 0) continue;

    let source;
    try {
      source = file.read().toString("utf8");
    } catch {
      continue;
    }
    const { imports } = collectSpecifiers(blankComments(source));
    for (const name of imports) {
      if (!isPackagedSpecifier(name)) continue;
      if (!required.has(name)) required.set(name, filePath);
    }
  }
  return required;
}

/**
 * Whether a package still has something loadable in the shipped app.
 *
 * A `package.json` alone is not enough: excluding `foo/**\/*` while a stray manifest survives leaves
 * a package Node can find and cannot load, which is a worse failure than a missing one.
 *
 * @param {Map<string, PackagedFile>} files
 * @param {string} name
 * @returns {{ present: boolean, manifest: boolean, loadableFiles: number }}
 */
export function inspectPackagePresence(files, name) {
  const needle = `node_modules/${name}/`;
  let manifest = false;
  let loadableFiles = 0;
  for (const filePath of files.keys()) {
    const index = filePath.indexOf(needle);
    if (index < 0) continue;
    const relative = filePath.slice(index + needle.length);
    if (relative.includes("node_modules/")) continue;
    if (relative === "package.json") manifest = true;
    else if (/\.(?:js|mjs|cjs|node|json|wasm)$/u.test(relative)) loadableFiles += 1;
  }
  return { present: manifest || loadableFiles > 0, manifest, loadableFiles };
}

/**
 * @returns {readonly string[]}
 */
function defaultAttributionGlobs() {
  const fromEnv = (process.env.T3X_DESKTOP_FILE_EXCLUSIONS ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
  return [...T3X_DESKTOP_FILE_EXCLUSIONS, ...fromEnv];
}

/**
 * Whether one of the fork's own exclusion globs is what removed a package.
 *
 * Every fork glob has the shape `!**\/node_modules/<name>/**\/*`, so attribution is a prefix
 * comparison rather than a glob engine. A trailing `*` in the package-name position is honoured
 * because upstream's own entry uses one (`@anthropic-ai/claude-agent-sdk-*`).
 *
 * The default set is the fork's own list PLUS anything passed through the environment for this build.
 * Both matter: the list is what a maintainer edits, and the environment is what the build actually used,
 * so consulting only the former misattributes an ad-hoc glob as "nothing here removed it".
 *
 * @param {string} name
 * @param {readonly string[]} [globs]
 * @returns {string | undefined} The glob responsible, if any.
 */
export function findExcludingGlob(name, globs = defaultAttributionGlobs()) {
  for (const glob of globs) {
    const match = /^!\*\*\/node_modules\/(.+?)\/\*\*\/?\*?$/u.exec(glob);
    if (match === null) continue;
    const pattern = match[1];
    if (pattern === name) return glob;
    if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return glob;
  }
  return undefined;
}

/**
 * @param {string} asarPath
 * @returns {{
 *   ok: boolean,
 *   checked: number,
 *   missing: { name: string, importedBy: string, glob: string | undefined }[],
 *   sidecars: string[],
 *   uncoveredBundleDirs: string[],
 *   totalBytes: number,
 *   totalFiles: number,
 *   mapBytes: number,
 * }}
 */
export function verifyPackagedApp(asarPath) {
  const files = readPackagedFiles(asarPath);

  // Windows ships the server tree as a resources/server.asar sidecar beside app.asar (see the
  // module header). Its archive and .unpacked sibling are part of the shipped app, so they join
  // the view: server bundles get scanned again, and a package that moved into the sidecar
  // (node-pty, for the WSL probe scripts) counts as loadable because it is.
  /** @type {string[]} */
  const sidecars = [];
  const serverAsarPath = NodePath.join(NodePath.dirname(asarPath), "server.asar");
  if (serverAsarPath !== asarPath && NodeFS.existsSync(serverAsarPath)) {
    for (const [relative, file] of readPackagedFiles(serverAsarPath)) {
      if (!files.has(relative)) files.set(relative, file);
    }
    sidecars.push(serverAsarPath);
  }

  const required = collectRequiredPackages(files);

  // A bundle directory nobody scanned is a layer this checker cannot see — exactly how the
  // pre-#102 gate verified only the Electron bundle on Windows and could not fail on the server
  // half. Absence must be an error, not an empty (green) result.
  const scannedDirs = new Set();
  for (const filePath of files.keys()) {
    for (const dir of FIRST_PARTY_BUNDLE_DIRS) {
      if (
        filePath.startsWith(`${dir}/`) &&
        [".js", ".mjs", ".cjs"].includes(NodePath.posix.extname(filePath))
      ) {
        scannedDirs.add(dir);
      }
    }
  }
  const uncoveredBundleDirs = FIRST_PARTY_BUNDLE_DIRS.filter((dir) => !scannedDirs.has(dir));

  /** @type {{ name: string, importedBy: string, glob: string | undefined }[]} */
  const missing = [];

  for (const [name, importedBy] of required) {
    const presence = inspectPackagePresence(files, name);
    if (presence.present && presence.loadableFiles > 0) continue;
    // `glob` enriches the message; it never softens the verdict. See the module header.
    missing.push({ name, importedBy, glob: findExcludingGlob(name) });
  }

  let totalBytes = 0;
  let mapBytes = 0;
  for (const [filePath, file] of files) {
    totalBytes += file.size;
    if (filePath.endsWith(".map")) mapBytes += file.size;
  }

  return {
    ok: missing.length === 0 && uncoveredBundleDirs.length === 0,
    checked: required.size,
    missing,
    sidecars,
    uncoveredBundleDirs,
    totalBytes,
    totalFiles: files.size,
    mapBytes,
  };
}

/**
 * @param {string} appDir A .app bundle, or any directory containing one.
 * @returns {string | undefined}
 */
export function findAsarInAppDir(appDir) {
  /** @type {string[]} */
  const stack = [appDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = NodePath.join(current, entry.name);
      if (entry.isFile() && entry.name === "app.asar") return full;
      if (entry.isDirectory() && !entry.name.endsWith(".asar.unpacked")) stack.push(full);
    }
  }
  return undefined;
}

/** @param {number} bytes */
function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
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
  const asarFlag = process.argv.indexOf("--asar");
  const appFlag = process.argv.indexOf("--verify-app");
  let asarPath;
  if (asarFlag >= 0) {
    asarPath = process.argv[asarFlag + 1];
  } else if (appFlag >= 0) {
    asarPath = findAsarInAppDir(process.argv[appFlag + 1]);
    if (asarPath === undefined) {
      process.stderr.write(
        `::error::No app.asar found under ${process.argv[appFlag + 1]}. Nothing was verified.\n`,
      );
      process.exit(1);
    }
  } else {
    process.stderr.write("usage: verify-desktop-bundle.mjs --asar <path> | --verify-app <dir>\n");
    process.exit(2);
  }

  const result = verifyPackagedApp(asarPath);
  process.stdout.write(
    [
      `app.asar:        ${asarPath}`,
      `sidecars:        ${result.sidecars.length > 0 ? result.sidecars.join(", ") : "none"}`,
      `packaged size:   ${formatMiB(result.totalBytes)} across ${result.totalFiles} files`,
      `source maps:     ${formatMiB(result.mapBytes)}`,
      `imports checked: ${result.checked} packages`,
      "",
    ].join("\n"),
  );

  if (result.uncoveredBundleDirs.length > 0) {
    process.stderr.write(
      `::error::No bundles found under ${result.uncoveredBundleDirs.join(", ")} in any packaged layer. A layer this checker cannot see passes nothing — the app's packaging topology changed and this script must learn the new location.\n`,
    );
  }
  if (result.missing.length > 0) {
    process.stderr.write(
      `::error::${result.missing.length} package(s) are imported by the packaged bundles but are not loadable from the shipped app. This bundle would throw MODULE_NOT_FOUND at runtime.\n`,
    );
    for (const entry of result.missing) {
      process.stderr.write(
        entry.glob === undefined
          ? `  ${entry.name} — imported by ${entry.importedBy}; no fork exclusion in desktop-file-exclusions.mjs matches it, so check upstream's packaging or a glob passed through T3X_DESKTOP_FILE_EXCLUSIONS\n`
          : `  ${entry.name} — imported by ${entry.importedBy}; removed by ${entry.glob} — fix that glob in scripts/coil/desktop-file-exclusions.mjs\n`,
      );
    }
  }
  if (!result.ok) process.exit(1);

  process.stdout.write("Desktop bundle verification passed.\n");
}
