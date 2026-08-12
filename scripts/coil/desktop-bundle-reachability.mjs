/*
 * Decides which packages in a staged desktop build are actually loadable at runtime.
 *
 * Issue #53. The desktop release bundle ships every production dependency of `apps/server` and
 * `apps/desktop`, transitively. Some of those trees exist only to be *bundled* by a client build —
 * `@clerk/clerk-js` is pulled in by `@clerk/electron/react`, which only `apps/web` imports, and
 * `apps/web` is compiled to `dist/client/assets/*.js` long before the artifact is staged. A bundled
 * import leaves nothing behind for Node to resolve, so those packages sit in the asar as dead
 * weight: shipped to every user, on every update, forever.
 *
 * "Dead weight" is an easy claim to make and an expensive one to get wrong. A package excluded from
 * the asar that something *does* require at runtime produces MODULE_NOT_FOUND in a shipped app, on
 * a code path that may not run until a user signs in. So this file does not guess. It reads the
 * built bundles the artifact actually loads, collects the module specifiers in them, resolves each
 * against the staged `node_modules`, and repeats over the resolved packages until the set stops
 * growing. What the closure never reaches, nothing can require.
 *
 * TWO KINDS OF EDGE, because one is not enough.
 *
 *   `import`  — a literal specifier: `require("x")`, `import … from "x"`, `import("x")`.
 *   `mention` — any string literal whose leading segment names an installed package.
 *
 * The second exists because of `playwright-core`, and it is worth stating plainly since it is the
 * trap this whole file is built around. `PlaywrightInjectedRuntime.ts` does
 * `require.resolve(PLAYWRIGHT_PACKAGE_SPECIFIER)` where the specifier is a `const`. After bundling
 * there is no literal left inside the `require.resolve()` call — the argument is a variable — so an
 * import-edge scanner reports `playwright-core` (11.9 MiB) as unreachable and anyone who trusts it
 * breaks the preview browser. The string `"playwright-core/package.json"` is still *in* the bundle,
 * though, and that is the signal `mention` edges pick up.
 *
 * So `mention` deliberately over-matches: a package named in a comment or an error message counts.
 * Being wrong that way keeps a package in the bundle, which costs bytes. Being wrong the other way
 * ships a broken app. When a package is reachable ONLY by mention, this file reports where the
 * mention was, because that is a question for a human and not for a regex.
 *
 * REMAINING BLIND SPOT: a specifier assembled at runtime out of pieces that never appear whole
 * (`require("play" + "wright-core")`, or a name read from a config file). Those sites are counted
 * and reported rather than ignored, because the honest answer to "is the closure complete?" is "it
 * is, apart from these N sites, which a human has looked at". A new dynamic site in a newly-added
 * package is a reason to re-check the exclusion list, not noise.
 *
 * `.mjs` for the same reason as its siblings here: CI runs it on the runner image's Node, with no
 * `setup-node` step in front of it.
 */

import * as NodeFS from "node:fs";
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
 * Matches the specifier in `require("x")`, `import … from "x"`, `import("x")`, `require.resolve("x")`.
 *
 * Written against the *shapes* rather than a grammar: bundlers emit all of these forms and
 * minifiers drop whitespace unpredictably. It over-matches — a specifier inside a comment counts —
 * which is the correct direction to be wrong in.
 */
const IMPORT_PATTERNS = [
  /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\.resolve\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
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
 * Blanks out comments, leaving everything else byte-for-byte in place.
 *
 * The reachability closure WANTS to read comments — over-matching there keeps a package in the
 * bundle, which is the safe direction. A release gate is the opposite: `scripts/coil/verify-desktop-bundle.mjs`
 * would fail a perfectly good build because `@noble/hashes`'s bundled JSDoc contains
 * `* import { hmac } from '@noble/hashes/hmac';` inside an `@example` block. That is a comment, not an
 * import, and blocking a release over it is worse than useless.
 *
 * Replacing comment bytes with spaces rather than deleting them keeps every character offset intact,
 * so a match's index still points at the right place in the original file.
 *
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
 * Resolves a package name the way Node does — walk `node_modules` up the directory chain — but
 * stopping at `rootDir`, so a stray hit in the developer's own tree cannot pass for a staged
 * dependency. Returns the *real* path: pnpm's layout is a forest of symlinks into `.pnpm`, and two
 * links to one directory are one package.
 *
 * @param {string} fromDir
 * @param {string} name
 * @param {string} rootDir
 * @returns {string | undefined}
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
 * Every package physically present in a staged `node_modules`, keyed by its real directory.
 *
 * Reads `node_modules/.pnpm` when it exists — that is where pnpm puts the one real copy of each
 * package — and also walks the top level, so the same function describes an npm-shaped tree.
 *
 * Sizes are summed from `stat().size`, NOT from `du`. This matters more than it sounds: `du` reports
 * *allocated* blocks, so on a 4 KiB-block filesystem a package of 3,684 tiny files (`core-js`)
 * measures ~15 MB of disk while holding 1.25 MiB of content. Issue #53's original size table was
 * measured with `du` and overstates every many-small-files package by up to an order of magnitude.
 *
 * @param {string} rootDir
 * @returns {Map<string, { name: string, version: string, dir: string, bytes: number, files: number }>}
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
 * @typedef {object} Reached
 * @property {string} name
 * @property {string} version
 * @property {string} dir
 * @property {"import" | "mention"} via How the closure first arrived here.
 * @property {string} from The package (or entry directory) that named it.
 */

/**
 * @param {string} rootDir
 * @param {readonly string[]} entryDirs Directories holding the built bundles the artifact loads.
 * @returns {{
 *   reachable: Map<string, Reached>,
 *   dynamicSites: number,
 *   entryFiles: number,
 * }}
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
 * Default entry directories: every tree of first-party code the packaged app can load.
 *
 * `apps/server/dist` includes `dist/client`, the compiled web renderer, on purpose. Those files
 * cannot resolve from `node_modules` in a browser context, so scanning them can only ever *add*
 * reachable packages — the safe direction. `dist/` (electron-builder's own output) is deliberately
 * absent: it holds a second copy of the whole tree, and walking it would mark every package
 * reachable from itself.
 */
export const DEFAULT_ENTRY_DIRS = ["apps/desktop/dist-electron", "apps/server/dist"];

/** @param {number} bytes */
function formatBytes(bytes) {
  const mib = bytes / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
