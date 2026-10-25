/*
 * Decides which staged desktop-build packages are loadable at runtime, by closing over the
 * specifiers in the built bundles. `import` edges are literal specifiers; `mention` edges (any
 * string naming a package) deliberately over-match so playwright-core's `const` specifier survives.
 * Runtime-assembled specifiers are counted and reported. `.mjs`: CI runs it without `setup-node`.
 */

import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

/**
 * Extensions worth scanning for module specifiers. `.node` is a compiled addon and `.json` cannot
 * require anything, so neither can contribute an edge.
 */
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts"]);

/**
 * `electron` resolves to a stub whose job is to hand back the runtime's built-in module, and it is a
 * devDependency of the stage — never in the packaged tree. Treating it as a package would make every
 * Electron API look like a missing dependency.
 */
const RUNTIME_PROVIDED = new Set(["electron"]);

/**
 * Matches `require("x")`, `import ... from "x"`, `import("x")` and `require.resolve("x")` by shape,
 * since minifiers vary; over-matching is the safe direction. The lookbehind skips member calls like
 * JXA's `ObjC.import("AppKit")`, framework names Node could never resolve.
 */
const IMPORT_PATTERNS = [
  /(?<![.\w$])require\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?<![.\w$])require\.resolve\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?<![.\w$])import\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /(?<![.\w$])import\s*["']([^"'\n]+)["']/g,
];

/** Any single- or double-quoted string with no newline in it. The `mention` edge source. */
const STRING_LITERAL_PATTERN = /["']([^"'\n]{1,200})["']/g;

/**
 * Matches a require/import whose argument is not a literal — `require(name)`, `import(`./${x}`)`.
 * These are the blind spots, so they are counted rather than silently dropped.
 */
const DYNAMIC_PATTERNS = [
  /\brequire\(\s*(?!["'])[^)\n]{1,120}\)/g,
  /\bimport\(\s*(?!["'])[^)\n]{1,120}\)/g,
];

/**
 * A valid npm package name, per the registry's rules plus the legacy uppercase names that predate
 * them. Without this the `from "…"` pattern happily matches prose out of a JSDoc block and the
 * report fills with garbage.
 */
const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Keywords after which a `/` begins a regex literal rather than a division. After an identifier,
 * a number, or a closing bracket it divides; after an operator, an opening bracket, or one of these
 * it cannot.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Whether the `/` at `index` opens a regex literal, judged by the previous significant token.
 *
 * @param {string} source
 * @param {number} index
 * @returns {boolean}
 */
function regexLiteralCanStartAt(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  const previous = source[cursor];
  if (/[\w$]/u.test(previous)) {
    let start = cursor;
    while (start > 0 && /[\w$]/u.test(source[start - 1])) start -= 1;
    const word = source.slice(start, cursor + 1);
    if (/^\d/u.test(word)) return false;
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  // `)` and `]` end an expression, so a `/` after them divides. Everything else — operators,
  // punctuation, an opening bracket — can only be followed by an operand.
  return previous !== ")" && previous !== "]";
}

/**
 * Index just past the regex literal and flags at `index`, so a quote in a class opens no string.
 * @param {string} source
 * @param {number} index
 * @returns {number}
 */
function skipRegexLiteral(source, index) {
  let cursor = index + 1;
  let inClass = false;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "\n") return cursor;
    if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "/") {
      cursor += 1;
      while (cursor < source.length && /[a-z]/u.test(source[cursor])) cursor += 1;
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

/**
 * Blanks comments with spaces (offsets intact) for the release gate, where a JSDoc `@example`
 * import must not fail a build. Regex literals are tracked so a `'` in one opens no runaway string.
 * @param {string} source
 * @returns {string}
 */
export function blankComments(source) {
  const out = source.split("");
  const length = source.length;
  /** @type {"code" | "line" | "block" | "single" | "double" | "template"} */
  let state = "code";
  let index = 0;

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out[index] = " ";
        out[index + 1] = " ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out[index] = " ";
        out[index + 1] = " ";
        index += 2;
        continue;
      }
      if (char === "/" && regexLiteralCanStartAt(source, index)) {
        index = skipRegexLiteral(source, index);
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      index += 1;
      continue;
    }

    if (state === "line") {
      if (char === "\n") {
        state = "code";
        index += 1;
        continue;
      }
      out[index] = " ";
      index += 1;
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        state = "code";
        index += 2;
        continue;
      }
      // Newlines survive so that line-based tooling downstream still sees the same line count.
      if (char !== "\n") out[index] = " ";
      index += 1;
      continue;
    }

    // Inside a string or template literal: honour escapes so that `"\\"` does not end the string.
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (
      (state === "single" && char === "'") ||
      (state === "double" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
    index += 1;
  }

  return out.join("");
}

/**
 * @param {string} specifier
 * @returns {string | undefined} The package name a specifier addresses, or undefined when the
 *   specifier is relative, absolute, a builtin, a protocol URL, or not a package name at all.
 */
export function packageNameFromSpecifier(specifier) {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  if (specifier.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(specifier)) return undefined;

  const segments = specifier.split("/");
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (!name || !PACKAGE_NAME_PATTERN.test(name)) return undefined;
  if (NodeModule.isBuiltin(name)) return undefined;
  return name;
}

/**
 * @param {string} source
 * @returns {{ imports: Set<string>, mentions: Set<string>, dynamicSites: number }}
 */
export function collectSpecifiers(source) {
  /** @type {Set<string>} */
  const imports = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = packageNameFromSpecifier(match[1]);
      if (name) imports.add(name);
    }
  }

  /** @type {Set<string>} */
  const mentions = new Set();
  STRING_LITERAL_PATTERN.lastIndex = 0;
  let literal;
  while ((literal = STRING_LITERAL_PATTERN.exec(source)) !== null) {
    const name = packageNameFromSpecifier(literal[1]);
    if (name && !imports.has(name)) mentions.add(name);
  }

  let dynamicSites = 0;
  for (const pattern of DYNAMIC_PATTERNS) {
    pattern.lastIndex = 0;
    while (pattern.exec(source) !== null) dynamicSites += 1;
  }

  return { imports, mentions, dynamicSites };
}

/**
 * Resolves a package like Node (walking `node_modules` upward) but stops at `rootDir`, so the
 * developer's own tree cannot pass for a staged dependency. Returns the real path, since pnpm's
 * symlinks into `.pnpm` mean two links to one directory are one package.
 */
export function resolvePackageDir(fromDir, name, rootDir) {
  let current = NodePath.resolve(fromDir);
  const root = NodePath.resolve(rootDir);
  for (;;) {
    const candidate = NodePath.join(current, "node_modules", name);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json"))) {
      try {
        return NodeFS.realpathSync(candidate);
      } catch {
        return undefined;
      }
    }
    if (current === root) return undefined;
    const parent = NodePath.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listFilesRecursively(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [dir];
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
        // Never descend into a nested dependency tree: those packages are reached through
        // resolution, and walking them here would attribute their edges to the wrong package.
        if (entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * @param {string} packageDir
 * @returns {{ name: string, version: string }}
 */
function readPackageIdentity(packageDir) {
  try {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
    );
    return {
      name: manifest.name ?? NodePath.basename(packageDir),
      version: manifest.version ?? "0",
    };
  } catch {
    return { name: NodePath.basename(packageDir), version: "0" };
  }
}

/**
 * Every package physically present in a staged `node_modules` (`.pnpm` plus the top level), keyed
 * by real directory. Sizes sum `stat().size`, NOT `du`: `du` counts allocated blocks and overstates
 * many-small-files packages (`core-js`) by up to an order of magnitude.
 */
export function collectInstalledPackages(rootDir) {
  /** @type {Map<string, { name: string, version: string, dir: string, bytes: number, files: number }>} */
  const packages = new Map();

  /** @param {string} packageDir */
  const record = (packageDir) => {
    let real;
    try {
      real = NodeFS.realpathSync(packageDir);
    } catch {
      return;
    }
    if (packages.has(real)) return;
    if (!NodeFS.existsSync(NodePath.join(real, "package.json"))) return;
    const identity = readPackageIdentity(real);
    let bytes = 0;
    let files = 0;
    for (const file of listFilesRecursively(real)) {
      try {
        bytes += NodeFS.statSync(file).size;
        files += 1;
      } catch {
        /* raced or dangling link */
      }
    }
    packages.set(real, { ...identity, dir: real, bytes, files });
  };

  /** @param {string} nodeModulesDir */
  const walkNodeModules = (nodeModulesDir) => {
    let entries;
    try {
      entries = NodeFS.readdirSync(nodeModulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".pnpm" || entry.name === ".bin") continue;
      const full = NodePath.join(nodeModulesDir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = NodeFS.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const inner of scoped) record(NodePath.join(full, inner.name));
        continue;
      }
      record(full);
    }
  };

  const pnpmDir = NodePath.join(rootDir, "node_modules", ".pnpm");
  if (NodeFS.existsSync(pnpmDir)) {
    for (const entry of NodeFS.readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      walkNodeModules(NodePath.join(pnpmDir, entry.name, "node_modules"));
    }
  }
  walkNodeModules(NodePath.join(rootDir, "node_modules"));

  return packages;
}

/**
 * `via` is how the closure first arrived; `from` is the package (or entry directory) that named it.
 * @typedef {{ name: string, version: string, dir: string, via: "import" | "mention",
 *   from: string }} Reached
 */

/**
 * @param {string} rootDir
 * @param {readonly string[]} entryDirs Directories holding the built bundles the artifact loads.
 * @returns {{ reachable: Map<string, Reached>, dynamicSites: number, entryFiles: number }}
 */
export function computeReachablePackages(rootDir, entryDirs) {
  /** @type {Map<string, Reached>} */
  const reachable = new Map();
  let dynamicSites = 0;
  let entryFiles = 0;

  /**
   * Breadth-first over (directory, files) frontiers. Import edges are taken before mention edges at
   * every level so that a package reachable both ways is attributed to the import — the report's
   * "only reachable by mention" list has to mean exactly that to be worth reading.
   *
   * @type {{ fromDir: string, files: readonly string[], origin: string }[]}
   */
  const frontier = [];

  for (const entryDir of entryDirs) {
    const absolute = NodePath.isAbsolute(entryDir) ? entryDir : NodePath.join(rootDir, entryDir);
    if (!NodeFS.existsSync(absolute)) continue;
    const files = listFilesRecursively(absolute);
    entryFiles += files.length;
    frontier.push({
      fromDir: rootDir,
      files,
      origin: NodePath.relative(rootDir, absolute) || absolute,
    });
  }

  while (frontier.length > 0) {
    const next = frontier.shift();
    if (next === undefined) break;

    /** @type {Set<string>} */
    const imports = new Set();
    /** @type {Set<string>} */
    const mentions = new Set();
    for (const file of next.files) {
      if (!SCANNED_EXTENSIONS.has(NodePath.extname(file))) continue;
      let source;
      try {
        source = NodeFS.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const result = collectSpecifiers(source);
      dynamicSites += result.dynamicSites;
      for (const name of result.imports) imports.add(name);
      for (const name of result.mentions) mentions.add(name);
    }

    for (const [names, via] of [
      [imports, /** @type {const} */ ("import")],
      [mentions, /** @type {const} */ ("mention")],
    ]) {
      for (const name of names) {
        if (RUNTIME_PROVIDED.has(name)) continue;
        if (via === "mention" && imports.has(name)) continue;
        const dir = resolvePackageDir(next.fromDir, name, rootDir);
        if (dir === undefined) continue;
        if (reachable.has(dir)) continue;
        const identity = readPackageIdentity(dir);
        reachable.set(dir, { ...identity, dir, via, from: next.origin });
        frontier.push({ fromDir: dir, files: listFilesRecursively(dir), origin: identity.name });
      }
    }
  }

  return { reachable, dynamicSites, entryFiles };
}

/**
 * The whole point, in one call: what is installed, what is loadable, and what is neither.
 *
 * @param {string} rootDir
 * @param {readonly string[]} entryDirs
 */
export function analyzeStage(rootDir, entryDirs) {
  const installed = collectInstalledPackages(rootDir);
  const { reachable, dynamicSites, entryFiles } = computeReachablePackages(rootDir, entryDirs);

  const unreachable = [...installed.values()]
    .filter((pkg) => !reachable.has(pkg.dir))
    .sort((a, b) => b.bytes - a.bytes);

  const mentionOnly = [...installed.values()]
    .filter((pkg) => reachable.get(pkg.dir)?.via === "mention")
    .map((pkg) => ({ ...pkg, from: reachable.get(pkg.dir)?.from ?? "?" }))
    .sort((a, b) => b.bytes - a.bytes);

  const totalBytes = [...installed.values()].reduce((sum, pkg) => sum + pkg.bytes, 0);
  const unreachableBytes = unreachable.reduce((sum, pkg) => sum + pkg.bytes, 0);

  return {
    installed,
    reachable,
    unreachable,
    mentionOnly,
    dynamicSites,
    entryFiles,
    totalBytes,
    unreachableBytes,
  };
}

/**
 * Every tree of first-party code the packaged app can load. `dist/client` (the web renderer) can
 * only add reachable packages, the safe direction. electron-builder's `dist/` is excluded: its
 * second copy of the tree would mark every package reachable from itself.
 */
export const DEFAULT_ENTRY_DIRS = ["apps/desktop/dist-electron", "apps/server/dist"];

/** @param {number} bytes */
function formatBytes(bytes) {
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
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
  const rootIndex = process.argv.indexOf("--stage");
  const rootDir = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  const limitIndex = process.argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 40;

  const report = analyzeStage(rootDir, DEFAULT_ENTRY_DIRS);
  process.stdout.write(
    [
      `stage:         ${rootDir}`,
      `entry files:   ${report.entryFiles}`,
      `installed:     ${report.installed.size} packages, ${formatBytes(report.totalBytes)}`,
      `reachable:     ${report.reachable.size} packages`,
      `unreachable:   ${report.unreachable.length} packages, ${formatBytes(report.unreachableBytes)}`,
      `dynamic sites: ${report.dynamicSites}`,
      "",
      `UNREACHABLE — no literal specifier and no string mention reaches these (top ${limit}):`,
      ...report.unreachable
        .slice(0, limit)
        .map(
          (pkg) =>
            `  ${formatBytes(pkg.bytes).padStart(9)}  ${String(pkg.files).padStart(5)} files  ${pkg.name}@${pkg.version}`,
        ),
      "",
      "REACHABLE BY MENTION ONLY — a string names them but nothing imports them. Adjudicate by hand:",
      ...report.mentionOnly
        .slice(0, limit)
        .map(
          (pkg) =>
            `  ${formatBytes(pkg.bytes).padStart(9)}  ${String(pkg.files).padStart(5)} files  ${pkg.name}@${pkg.version}  <- named by ${pkg.from}`,
        ),
      "",
    ].join("\n"),
  );
}
