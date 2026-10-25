/*
 * Fails a release whose packaged app is missing a package its own bundles require, guarding the
 * fork's asar exclusions. Merges every layer (`app.asar`, `.unpacked`, Windows' `server.asar`) and
 * fails if a FIRST_PARTY_BUNDLE_DIRS entry went unscanned. ANY missing import fails, whoever
 * removed it; attribution only names the glob. `.mjs`: CI runs it without `setup-node`.
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
import { isRuntimeExternalCliDependency } from "../lib/cli-external-packages.ts";
import { isDesktopRuntimeExternalDependency } from "../lib/desktop-external-packages.ts";

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

/*
 * Imports the shipped app never reaches: the server imports these only behind Bun detection
 * (server.ts HttpServerLive, persistence/Layers/Sqlite.ts), and desktop always runs it under Node.
 * If the shipped server ever runs under Bun this list is wrong: re-check both guard sites first.
 */
const UNREACHABLE_IN_SHIPPED_RUNTIME = new Set(["@effect/platform-bun", "@effect/sql-sqlite-bun"]);

/**
 * @typedef {object} PackagedFile
 * @property {number} size
 * @property {() => Buffer} read
 */

/**
 * Parses an asar (16-byte pickle preamble, JSON listing, contents) into a path -> file view from
 * the listing alone, so there is no extraction step and no @electron/asar dependency.
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
  if (UNREACHABLE_IN_SHIPPED_RUNTIME.has(name)) return false;
  return !BUNDLED_WORKSPACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Packages the first-party bundles import, by `import` edges only (a mention is no evidence of
 * breakage). Comments are blanked first so a bundled JSDoc `@example` import cannot fail a build.
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
    // Upstream's stage installs ONLY each layer's native externals (desktop-external-packages.ts
    // for the Electron main, cli-external-packages.ts for the server), so anything else a bundle
    // names has no node_modules presence by construction. That is upstream's bundling decision,
    // not a fork exclusion, so only externals are required here.
    const isExternal = filePath.startsWith("apps/desktop/dist-electron/")
      ? isDesktopRuntimeExternalDependency
      : isRuntimeExternalCliDependency;
    const { imports } = collectSpecifiers(blankComments(source));
    for (const name of imports) {
      if (!isPackagedSpecifier(name)) continue;
      if (!isExternal(name)) continue;
      if (!required.has(name)) required.set(name, filePath);
    }
  }
  return required;
}

/**
 * Whether a package still has something loadable; a surviving `package.json` alone does not count.
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
 * The fork exclusion glob that removed a package, if any. Every glob is
 * `!**\/node_modules/<name>/**\/*`, so this is a prefix compare honouring a trailing `*` (upstream's
 * claude-agent-sdk entry). Defaults add this build's env globs, or an ad-hoc glob goes unattributed.
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
 * @returns {import("./verify-desktop-bundle.d.mts").VerifyResult}
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
 * Whether this module was run directly, rather than imported. Comparing against
 * `file://${process.argv[1]}` never matches on Windows (native `D:\` path), so the CLI silently did
 * nothing and exited 0. `pathToFileURL` is correct on every platform.
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
