// @effect-diagnostics nodeBuiltinImport:off - Writes a real asar fixture to a temp dir; the point is to
// exercise the plain-Node file handling that verify-desktop-bundle.mjs uses on a CI runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  blankComments,
  collectSpecifiers,
  packageNameFromSpecifier,
} from "./desktop-bundle-reachability.mjs";
import {
  assertNoSeparatorInGlobs,
  DESKTOP_FILE_EXCLUSIONS_ENV_NAME,
  renderExclusionEnvValue,
  T3X_DESKTOP_FILE_EXCLUSION_GROUPS,
  T3X_DESKTOP_FILE_EXCLUSIONS,
} from "./desktop-file-exclusions.mjs";
import { resolveGitHubPublishConfig } from "../build-desktop-artifact.ts";
import {
  findExcludingGlob,
  inspectPackagePresence,
  isPackagedSpecifier,
  readAsarFiles,
  verifyPackagedApp,
} from "./verify-desktop-bundle.mjs";

/*
 * Issue #53. These three files decide what does and does not reach a user's disk, and the expensive
 * failure is silent: an over-broad glob ships MODULE_NOT_FOUND on a path that may not run until
 * someone signs in. The tests below are grouped by the question each answers —
 *
 *   - does the closure see the edges it has to see (the playwright-core trap)?
 *   - is the exclusion list still the shape the upstream hook can consume, and does it still avoid
 *     every package the main process loads?
 *   - does the release gate fail every missing import, whether or not a fork glob can be blamed?
 *   - do all three build paths still agree, after a sync?
 */

describe("packageNameFromSpecifier", () => {
  it("reads plain and scoped names, with or without a subpath", () => {
    assert.strictEqual(packageNameFromSpecifier("shiki"), "shiki");
    assert.strictEqual(packageNameFromSpecifier("shiki/core"), "shiki");
    assert.strictEqual(packageNameFromSpecifier("@clerk/electron"), "@clerk/electron");
    assert.strictEqual(packageNameFromSpecifier("@clerk/electron/storage"), "@clerk/electron");
    assert.strictEqual(packageNameFromSpecifier("playwright-core/package.json"), "playwright-core");
  });

  it("ignores everything that is not a package", () => {
    for (const specifier of [
      "./local",
      "../up",
      "/absolute",
      "node:fs",
      "fs",
      "path",
      "bun:sqlite",
      "https://example.com/x.js",
      "#internal",
      "",
    ]) {
      assert.strictEqual(
        packageNameFromSpecifier(specifier),
        undefined,
        `${specifier} should not read as a package`,
      );
    }
  });

  // This is what kept the first version of the report full of garbage: `from "…"` matches prose out
  // of a JSDoc block, and without a name check every sentence fragment became a "package".
  it("rejects strings that cannot be package names", () => {
    for (const specifier of [
      "hello world",
      "a b/c",
      " leading",
      "@scope",
      "@/nope",
      "-starts-with-dash",
    ]) {
      assert.strictEqual(
        packageNameFromSpecifier(specifier),
        undefined,
        `${specifier} should not read as a package`,
      );
    }
  });
});

describe("collectSpecifiers", () => {
  it("finds every import form a bundler emits", () => {
    const { imports } = collectSpecifiers(`
      const a = require("pkg-a");
      import b from "pkg-b";
      const c = await import("pkg-c");
      export { d } from "pkg-d";
      import "pkg-e";
      const f = require.resolve("pkg-f");
    `);
    for (const name of ["pkg-a", "pkg-b", "pkg-c", "pkg-d", "pkg-e", "pkg-f"]) {
      assert.ok(imports.has(name), `${name} was not collected as an import`);
    }
  });

  /*
   * THE playwright-core TRAP, which is the whole reason mention edges exist.
   *
   * PlaywrightInjectedRuntime.ts does `require.resolve(PLAYWRIGHT_PACKAGE_SPECIFIER)` where the
   * specifier is a `const`. After bundling there is no literal inside the call, so an import-edge
   * scanner calls playwright-core (10.2 MiB) dead and anyone who trusts it breaks the preview
   * browser. The string survives in the bundle; that is the signal.
   */
  it("catches a package named only by a string constant, as playwright-core is", () => {
    const source = `
      const PLAYWRIGHT_PACKAGE_SPECIFIER = "playwright-core/package.json";
      const resolved = require.resolve(PLAYWRIGHT_PACKAGE_SPECIFIER);
    `;
    const { imports, mentions } = collectSpecifiers(source);
    assert.isFalse(imports.has("playwright-core"), "should not be a literal import edge");
    assert.ok(mentions.has("playwright-core"), "should be caught as a mention edge");
  });

  it("counts the dynamic sites it cannot see, rather than hiding them", () => {
    const { dynamicSites } = collectSpecifiers(`
      require(computedName);
      import(anotherName);
    `);
    assert.strictEqual(dynamicSites, 2);
  });

  it("does not report a package as both an import and a mention", () => {
    const { imports, mentions } = collectSpecifiers(`
      require("pkg-a");
      const label = "pkg-a";
    `);
    assert.ok(imports.has("pkg-a"));
    assert.isFalse(mentions.has("pkg-a"));
  });
});

describe("blankComments", () => {
  /*
   * Verbatim shape of the bundled @noble/hashes JSDoc that failed the release gate on a build with
   * nothing wrong with it. `@noble/hashes` is inlined into bin.mjs and was never installed, so the
   * `@example` block read as an import of a package that is legitimately absent.
   */
  it("removes the @noble/hashes @example block that produced a false release failure", () => {
    const source = [
      "/**",
      "* HMAC: RFC2104 message authentication code.",
      "* @example",
      "* import { hmac } from '@noble/hashes/hmac';",
      "* import { sha256 } from '@noble/hashes/sha2';",
      "*/",
      'const real = require("effect");',
    ].join("\n");
    const { imports } = collectSpecifiers(blankComments(source));
    assert.isFalse(imports.has("@noble/hashes"), "a JSDoc example is not an import");
    assert.ok(imports.has("effect"), "real code beside the comment must survive");
  });

  it("keeps offsets and line counts stable so downstream matches still point at the right place", () => {
    const source = "const a = 1; // note\nconst b = 2;\n/* x\ny */\nconst c = 3;\n";
    const blanked = blankComments(source);
    assert.strictEqual(blanked.length, source.length);
    assert.strictEqual(blanked.split("\n").length, source.split("\n").length);
    assert.ok(blanked.includes("const a = 1;"));
    assert.ok(blanked.includes("const c = 3;"));
    assert.isFalse(blanked.includes("note"));
  });

  it("does not mistake comment markers inside strings for comments", () => {
    const source = [
      'const url = "https://example.com/x";',
      "const glob = '/* not a comment */';",
      "const tpl = `// also not a comment`;",
      'require("effect");',
    ].join("\n");
    const blanked = blankComments(source);
    assert.ok(blanked.includes("https://example.com/x"), "a URL's // must survive");
    assert.ok(blanked.includes("/* not a comment */"));
    assert.ok(blanked.includes("// also not a comment"));
    assert.ok(collectSpecifiers(blanked).imports.has("effect"));
  });

  it("handles an escaped quote without falling out of the string", () => {
    const source = ['const a = "he said \\"hi\\" // not a comment";', 'require("effect");'].join(
      "\n",
    );
    const blanked = blankComments(source);
    assert.ok(blanked.includes("// not a comment"));
    assert.ok(collectSpecifiers(blanked).imports.has("effect"));
  });
});

describe("the exclusion list", () => {
  it("passes through the environment without being mangled", () => {
    assertNoSeparatorInGlobs(T3X_DESKTOP_FILE_EXCLUSIONS);
    const rendered = renderExclusionEnvValue();
    assert.deepStrictEqual(rendered.split(","), T3X_DESKTOP_FILE_EXCLUSIONS);
  });

  // A `{a,b}` brace group would be split down the middle by the comma separator and silently become
  // two globs that match nothing — an exclusion that quietly stops excluding.
  it("rejects a glob containing the separator", () => {
    assert.throws(
      () => assertNoSeparatorInGlobs(["!**/node_modules/{a,b}/**/*"]),
      new RegExp(DESKTOP_FILE_EXCLUSIONS_ENV_NAME),
    );
  });

  it("is made only of negated node_modules globs, so nothing can be added by accident", () => {
    for (const glob of T3X_DESKTOP_FILE_EXCLUSIONS) {
      assert.ok(glob.startsWith("!"), `${glob} is not a negation — it would ADD files`);
      assert.ok(glob.includes("node_modules/"), `${glob} reaches outside node_modules`);
    }
  });

  it("has no duplicates", () => {
    assert.strictEqual(
      new Set(T3X_DESKTOP_FILE_EXCLUSIONS).size,
      T3X_DESKTOP_FILE_EXCLUSIONS.length,
    );
  });

  /*
   * The main process requires `@clerk/electron` and `@clerk/electron/storage`, and the passkey native
   * binaries are staged deliberately by stageClerkPasskeyNativeBinaries(). Excluding any of them is
   * the one mistake in this area that breaks sign-in outright, so it is asserted rather than trusted
   * to a code comment.
   */
  it("never excludes the Clerk packages the main process actually loads", () => {
    for (const name of [
      "@clerk/electron",
      "@clerk/electron-passkeys",
      "@clerk/electron-passkeys-darwin-arm64",
      "@clerk/electron-passkeys-win32-x64-msvc",
      "electron-store",
      "electron-updater",
    ]) {
      assert.strictEqual(
        findExcludingGlob(name),
        undefined,
        `${name} is required at runtime but a glob removes it`,
      );
    }
  });

  it("never excludes the packages issue #53 named as traps", () => {
    // playwright-core is loaded through require.resolve() on a const; undici is probed dynamically by
    // HTTP clients; msgpackr's native accelerator is loaded by an assembled path.
    for (const name of [
      "playwright-core",
      "undici",
      "@msgpackr-extract/msgpackr-extract-darwin-arm64",
    ]) {
      assert.strictEqual(findExcludingGlob(name), undefined, `${name} must stay in the bundle`);
    }
  });

  it("still covers the three trees that were measured, so a bad merge cannot quietly empty it", () => {
    const { thirdPartySourceMaps, clerkBrowserSdk, diffRenderer } =
      T3X_DESKTOP_FILE_EXCLUSION_GROUPS;
    assert.deepStrictEqual(thirdPartySourceMaps, ["!**/node_modules/**/*.map"]);
    for (const name of ["@clerk/clerk-js", "@clerk/react", "@clerk/shared", "core-js", "lodash"]) {
      assert.ok(
        clerkBrowserSdk.some((glob) => glob.includes(`/${name}/`)),
        `${name} fell out of the Clerk group`,
      );
    }
    for (const name of ["@pierre/diffs", "@shikijs/langs", "shiki"]) {
      assert.ok(
        diffRenderer.some((glob) => glob.includes(`/${name}/`)),
        `${name} fell out of the diff-renderer group`,
      );
    }
  });
});

describe("findExcludingGlob", () => {
  it("attributes a removal to the glob responsible", () => {
    assert.strictEqual(
      findExcludingGlob("shiki", ["!**/node_modules/shiki/**/*"]),
      "!**/node_modules/shiki/**/*",
    );
    assert.strictEqual(
      findExcludingGlob("@shikijs/langs", ["!**/node_modules/@shikijs/langs/**/*"]),
      "!**/node_modules/@shikijs/langs/**/*",
    );
  });

  it("honours a trailing wildcard, as upstream's own entry uses one", () => {
    const globs = ["!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*"];
    assert.ok(findExcludingGlob("@anthropic-ai/claude-agent-sdk-darwin-arm64", globs));
    assert.strictEqual(findExcludingGlob("@anthropic-ai/claude-agent-sdk", globs), undefined);
  });

  it("does not attribute a package that merely shares a prefix", () => {
    assert.strictEqual(
      findExcludingGlob("shiki-stream", ["!**/node_modules/shiki/**/*"]),
      undefined,
    );
    assert.strictEqual(findExcludingGlob("regex", ["!**/node_modules/regexp/**/*"]), undefined);
  });
});

describe("isPackagedSpecifier", () => {
  it("skips what the runtime provides and what the bundler inlined", () => {
    assert.isFalse(isPackagedSpecifier("electron"), "electron is synthesized by the runtime");
    assert.isFalse(isPackagedSpecifier("@t3tools/shared"), "workspace packages are bundled");
    assert.isFalse(isPackagedSpecifier("node:fs"));
    assert.ok(isPackagedSpecifier("effect"));
    assert.ok(isPackagedSpecifier("@clerk/electron"));
  });
});

describe("inspectPackagePresence", () => {
  const listing = (paths: readonly string[]) =>
    new Map(paths.map((p) => [p, { size: 1, read: () => Buffer.alloc(0) }]));

  it("finds a package that still has loadable files", () => {
    const result = inspectPackagePresence(
      listing(["node_modules/effect/package.json", "node_modules/effect/dist/index.js"]),
      "effect",
    );
    assert.ok(result.present);
    assert.strictEqual(result.loadableFiles, 1);
  });

  // The nastiest survivable state: a manifest Node can find with nothing behind it. That resolves and
  // then throws, which is harder to diagnose than a package that is simply absent.
  it("treats a lone package.json as not loadable", () => {
    const result = inspectPackagePresence(listing(["node_modules/shiki/package.json"]), "shiki");
    assert.ok(result.manifest);
    assert.strictEqual(result.loadableFiles, 0);
  });

  it("does not credit a package for files belonging to its own nested dependencies", () => {
    const result = inspectPackagePresence(
      listing(["node_modules/a/package.json", "node_modules/a/node_modules/b/index.js"]),
      "a",
    );
    assert.strictEqual(result.loadableFiles, 0, "b's files are not a's");
  });

  it("finds a package nested under .pnpm, which is where every real copy lives", () => {
    const result = inspectPackagePresence(
      listing(["node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/index.js"]),
      "effect",
    );
    assert.ok(result.present);
  });

  it("reports a fully excluded package as absent", () => {
    assert.isFalse(inspectPackagePresence(listing(["node_modules/effect/x.js"]), "shiki").present);
  });
});

/*
 * The packaging seam has to agree in two places, and nothing at runtime would notice if it stopped.
 *
 * `scripts/build-desktop-artifact.ts` is upstream-owned and hot. An upstream sync that reverts its one
 * added expression leaves every release packaging the unfiltered 189.66 MiB bundle again — green,
 * shipped, and twice the size it should be. A release workflow that forgets to SET the variables ships
 * the same regression. Both are cheap to assert here and invisible in the wild.
 *
 * Two places rather than three because #92 retired the local desktop autobuild: `coil-release.yml` is
 * now the only path that builds a shipping artifact. If a local build path is ever reintroduced, it has
 * to set both variables or it will produce an artifact materially unlike the one users get — add a case
 * here when that happens.
 */
it.layer(NodeServices.layer)("the packaging seam agrees everywhere", (it) => {
  const readRepoFile = (...segments: readonly string[]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fs.readFileString(path.join(import.meta.dirname, "..", "..", ...segments));
    });

  it.effect("build-desktop-artifact.ts still splices the fork's exclusions in", () =>
    Effect.gen(function* () {
      const source = yield* readRepoFile("scripts", "build-desktop-artifact.ts");

      assert.match(
        source,
        /process\.env\.T3X_DESKTOP_FILE_EXCLUSIONS/,
        "the fork's exclusion seam is gone from build-desktop-artifact.ts — a sync probably reverted it",
      );
      assert.match(
        source,
        /\.\.\.coilExtraFileExclusions,/,
        "the exclusions are parsed but never spliced into DESKTOP_FILE_EXCLUSIONS",
      );
      // The whole reason this is an env hook and not an edited literal: upstream's own test asserts
      // the array deep-equals exactly its one entry, so the default must stay untouched.
      assert.match(
        source,
        /"!\*\*\/node_modules\/@anthropic-ai\/claude-agent-sdk-\*\/\*\*\/\*",/,
        "upstream's own exclusion was displaced — its test asserts this array's exact contents",
      );
    }),
  );

  it.effect("the release workflow sets both variables and verifies the result", () =>
    Effect.gen(function* () {
      const workflow = yield* readRepoFile(".github", "workflows", "coil-release.yml");

      assert.match(workflow, /T3CODE_WEB_SOURCEMAP: "0"/, "renderer source maps are back on");
      assert.match(
        workflow,
        /T3X_DESKTOP_FILE_EXCLUSIONS: \$\{\{ steps\.exclusions\.outputs\.value \}\}/,
        "the exclusion list never reaches the build",
      );
      // Scoped to one step, never exported job-wide: upstream's test asserts DESKTOP_FILE_EXCLUSIONS
      // deep-equals exactly its one entry, so a job-wide export makes `vp test` fail in that job with
      // a confusing 68-vs-1 array diff.
      assert.notMatch(
        workflow,
        /T3X_DESKTOP_FILE_EXCLUSIONS=.*>> "\$GITHUB_ENV"/,
        "exporting the exclusions job-wide breaks upstream's own test in that job",
      );
      assert.match(
        workflow,
        /node scripts\/coil\/desktop-file-exclusions\.mjs/,
        "the workflow hardcodes a list instead of reading the single source",
      );
      assert.match(
        workflow,
        /node scripts\/coil\/verify-desktop-bundle\.mjs/,
        "the compensating control is not wired into the release",
      );
    }),
  );

  /*
   * #92 retired scripts/coil/auto-build-desktop.sh, so the release workflow is the only path that
   * builds a shipping artifact and the only place these variables have to be set. This asserts that
   * premise rather than trusting it: if a second build path returns, it will package an artifact
   * roughly twice the size of the one users receive unless it sets both variables too, and the
   * failure is invisible — a green build of the wrong bundle.
   */
  it.effect("has no second build path that could package a different bundle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = path.join(import.meta.dirname, "..", "..");
      const retired = path.join(repoRoot, "scripts", "coil", "auto-build-desktop.sh");

      assert.isFalse(
        yield* fs.exists(retired),
        "the local autobuild is back; it must set T3CODE_WEB_SOURCEMAP and T3X_DESKTOP_FILE_EXCLUSIONS, then get a case here",
      );
    }),
  );
});

/*
 * End-to-end over a real asar, built here rather than mocked.
 *
 * These exist because of a bug that a unit test could not have caught. An earlier draft classified a
 * missing package as an error only when the fork's own list named the glob, and warned otherwise. A
 * negative test — a real build with a deliberately over-broad `!**\/node_modules/effect/**\/*` passed
 * through the environment — produced a bundle that cannot start, and the gate went GREEN: `effect` was
 * detected as missing but attributed to nobody, so it warned. Severity must not depend on attribution.
 *
 * Writing an actual archive also exercises the header arithmetic, which is the part of that file most
 * able to be quietly wrong: file offsets are relative to `8 + <the leading size word>`, and getting it
 * wrong reads misaligned bytes that still parse as plausible JavaScript.
 */
describe("verifyPackagedApp over a real asar", () => {
  /** Writes a minimal but format-correct asar: [4][8+n+pad][4+n+pad][n][json][pad][contents]. */
  const writeAsar = (dir: string, files: Record<string, string>, name = "app.asar"): string => {
    const entries: Record<string, { size: number; offset: string }> = {};
    const blobs: Buffer[] = [];
    let offset = 0;
    for (const [name, contents] of Object.entries(files)) {
      const buffer = Buffer.from(contents, "utf8");
      entries[name] = { size: buffer.length, offset: String(offset) };
      blobs.push(buffer);
      offset += buffer.length;
    }
    // Nest each slash-separated path back into the tree shape asar uses.
    const root: Record<string, unknown> = { files: {} };
    for (const [name, meta] of Object.entries(entries)) {
      const segments = name.split("/");
      let node = root as { files: Record<string, unknown> };
      for (const segment of segments.slice(0, -1)) {
        const children = node.files as Record<string, { files: Record<string, unknown> }>;
        children[segment] ??= { files: {} };
        node = children[segment] as { files: Record<string, unknown> };
      }
      (node.files as Record<string, unknown>)[segments.at(-1) as string] = meta;
    }

    const json = Buffer.from(JSON.stringify(root), "utf8");
    const pad = (4 - (json.length % 4)) % 4;
    const preamble = Buffer.alloc(16);
    preamble.writeUInt32LE(4, 0);
    preamble.writeUInt32LE(8 + json.length + pad, 4);
    preamble.writeUInt32LE(4 + json.length + pad, 8);
    preamble.writeUInt32LE(json.length, 12);

    const asarPath = NodePath.join(dir, name);
    NodeFS.writeFileSync(asarPath, Buffer.concat([preamble, json, Buffer.alloc(pad), ...blobs]));
    return asarPath;
  };

  const withTempDir = <A>(use: (dir: string) => A): A => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "coil-asar-"));
    try {
      return use(dir);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads a package back out at the right offset", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/server/dist/bin.mjs": 'import x from "effect";\n',
        "apps/desktop/dist-electron/main.cjs": "const x = 1;",
        "node_modules/effect/package.json": '{"name":"effect"}',
        "node_modules/effect/dist/index.js": "module.exports = {};",
      });
      const files = readAsarFiles(asarPath);
      assert.strictEqual(
        files.get("apps/server/dist/bin.mjs")?.read().toString("utf8"),
        'import x from "effect";\n',
        "offset arithmetic is wrong — this read the wrong bytes",
      );
      assert.ok(verifyPackagedApp(asarPath).ok, "a complete bundle must pass");
    });
  });

  // The regression. `unrelated-pkg` is named by no glob at all, so the old code warned and passed.
  it("FAILS a missing import even when no glob can be blamed for it", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/server/dist/bin.mjs": 'import x from "unrelated-pkg";\n',
        "node_modules/effect/package.json": '{"name":"effect"}',
      });
      const result = verifyPackagedApp(asarPath);
      assert.isFalse(result.ok, "severity must not depend on attribution");
      assert.strictEqual(result.missing.length, 1);
      assert.strictEqual(result.missing[0]?.name, "unrelated-pkg");
      assert.strictEqual(result.missing[0]?.glob, undefined, "nothing should be blamed");
    });
  });

  it("names the fork's glob when the fork's list is what removed the package", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/server/dist/bin.mjs": 'import s from "shiki";\n',
      });
      const result = verifyPackagedApp(asarPath);
      assert.isFalse(result.ok);
      assert.strictEqual(result.missing[0]?.glob, "!**/node_modules/shiki/**/*");
    });
  });

  // A manifest with nothing behind it resolves and then throws, which is harder to diagnose than an
  // absent package. It has to count as missing.
  it("fails a package left with only a package.json", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/server/dist/bin.mjs": 'import x from "effect";\n',
        "node_modules/effect/package.json": '{"name":"effect"}',
      });
      assert.isFalse(verifyPackagedApp(asarPath).ok);
    });
  });

  it("does not fail on a package named only inside a comment", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        // The @noble/hashes shape that failed a good release before comments were blanked.
        "apps/server/dist/bin.mjs":
          "/**\n * @example\n * import { hmac } from '@noble/hashes/hmac';\n */\nconst x = 1;\n",
        "apps/desktop/dist-electron/main.cjs": "const x = 1;",
      });
      assert.ok(verifyPackagedApp(asarPath).ok, "a JSDoc example is not an import");
    });
  });

  it("ignores what the runtime provides and what the bundler inlined", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/desktop/dist-electron/main.cjs":
          'require("electron");require("@t3tools/shared");require("node:fs");',
        "apps/server/dist/bin.mjs": "const x = 1;",
      });
      assert.ok(verifyPackagedApp(asarPath).ok);
    });
  });

  /*
   * The 2026-08-14 regression (issue #102). Upstream moved the Windows server tree out of app.asar
   * into a resources/server.asar sidecar: node-pty (mentioned by main.cjs's embedded WSL scripts)
   * stopped resolving from app.asar and the gate went red on a shippable build — and, worse, the
   * server bundles silently stopped being scanned at all. The sidecar is part of the shipped app;
   * the view must include it.
   */
  it("resolves imports from a sibling server.asar sidecar and scans its bundles", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/desktop/dist-electron/main.cjs": 'require("node-pty");',
      });
      writeAsar(
        dir,
        {
          // The server bundle imports a package that exists nowhere: with the sidecar merged into
          // the view this MUST fail, proving server bundles are scanned rather than merely stored.
          "apps/server/dist/bin.mjs": 'import x from "not-shipped";\n',
          "node_modules/node-pty/package.json": '{"name":"node-pty"}',
          "node_modules/node-pty/lib/index.js": "module.exports = {};",
        },
        "server.asar",
      );
      const result = verifyPackagedApp(asarPath);
      assert.deepStrictEqual(result.uncoveredBundleDirs, [], "sidecar bundles must be visible");
      assert.deepStrictEqual(
        result.missing.map((entry) => entry.name),
        ["not-shipped"],
        "node-pty resolves from the sidecar; the sidecar's own broken import still fails",
      );
    });
  });

  // The Bun-runtime variants are imported behind runtime detection the shipped app (always Node,
  // via ELECTRON_RUN_AS_NODE) can never satisfy, and upstream's Windows sidecar deliberately omits
  // them — their absence is not a break. Release run 31839839479 failed on exactly this.
  it("does not require Bun-runtime-only packages the shipped app cannot load", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/server/dist/bin.mjs":
          'import("@effect/platform-bun/BunHttpServer");import("@effect/sql-sqlite-bun/SqliteClient");',
        "apps/desktop/dist-electron/main.cjs": "const x = 1;",
      });
      assert.ok(verifyPackagedApp(asarPath).ok, "unreachable Bun-runtime imports are not breaks");
    });
  });

  // A packaging-topology change that hides a whole bundle directory must be an error, not an empty
  // green result — the pre-#102 gate verified only the Electron bundle on Windows and passed.
  it("fails when a first-party bundle directory is invisible to the checker", () => {
    withTempDir((dir) => {
      const asarPath = writeAsar(dir, {
        "apps/desktop/dist-electron/main.cjs": 'require("electron");',
      });
      const result = verifyPackagedApp(asarPath);
      assert.isFalse(result.ok, "an unscanned layer must fail the release");
      assert.deepStrictEqual(result.uncoveredBundleDirs, ["apps/server/dist"]);
    });
  });
});

/*
 * The regression that broke two releases: all three of these scripts are also CLIs, and their
 * entry-point guard was `import.meta.url === `file://${process.argv[1]}``. That is false on Windows,
 * where `process.argv[1]` is a native path — so `node <script>` parsed, ran nothing, wrote nothing,
 * and exited 0.
 *
 * The failure mode is what makes it worth a test rather than a comment. Both CI callers run under
 * `set -euo pipefail` and neither could tell "did the work" from "did nothing": the exclusions call
 * failed the release on empty stdout, and the bundle verification passed a check that never
 * executed. Exit code 0 is the wrong signal for both.
 *
 * These assert the shape that broke — invoked as a CLI, the script must actually do something — for
 * whichever platform the suite runs on. They cannot themselves run on Windows (this fork has no
 * Windows CI runner), so the correctness argument for that platform stays with `pathToFileURL`,
 * which is what Node provides for exactly this conversion.
 */
describe("the scripts still work when invoked as CLIs", () => {
  const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

  it("desktop-file-exclusions.mjs writes the list to stdout", () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(scriptDir, "desktop-file-exclusions.mjs")],
      { encoding: "utf8" },
    );

    assert.strictEqual(result.status, 0, result.stderr);
    // The exact failure: exit 0 with nothing written. An empty list is what the release step
    // rejects, so asserting "not empty" is asserting the thing that actually broke.
    assert.isNotEmpty(
      result.stdout,
      "the CLI produced no output, so its entry-point guard is wrong",
    );
    assert.strictEqual(result.stdout, renderExclusionEnvValue());
  });

  it("verify-desktop-bundle.mjs refuses to exit 0 when handed nothing to verify", () => {
    // The other half. A verifier whose main never runs is indistinguishable from one that passed,
    // and this is the call the release makes, so it must fail loudly rather than quietly succeed.
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(scriptDir, "verify-desktop-bundle.mjs")],
      { encoding: "utf8" },
    );

    assert.notStrictEqual(result.status, 0, "a no-argument run must not look like a pass");
  });
});

/*
 * The fork ships exactly one update surface: its own toast. Upstream's electron-updater turns
 * itself on the moment `app-update.yml` is in the bundle, and electron-builder writes that file
 * whenever a publish config is resolved — so "no publish config" IS the mechanism, and it is worth
 * one test.
 *
 * The release workflow tried to get there with `GITHUB_REPOSITORY: ""`, which cannot work: Actions
 * refuses to let a workflow set a `GITHUB_`-prefixed variable, so the build read the runner's real
 * value and every build to date shipped a live feed pointing at radroid/t3code. It went unnoticed
 * because the step meant to catch it searched the wrong directory and could never fail.
 *
 * `T3CODE_DESKTOP_UPDATE_REPOSITORY` is the fork's own hook, is read FIRST, and is not reserved.
 * Asserted here rather than in build-desktop-artifact.test.ts, which is upstream's file — the
 * function is exported, so the fork can pin fork behaviour without spending a seam row.
 */
describe("the fork ships no update feed", () => {
  const withEnv = (env: Record<string, string>) =>
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

  it.effect("resolves no publish config when the fork's hook is set to a non-repo value", () =>
    Effect.gen(function* () {
      const config = yield* resolveGitHubPublishConfig("latest").pipe(
        // Exactly what coil-release.yml sets, alongside the GITHUB_REPOSITORY the runner provides
        // and the workflow cannot remove. The hook short-circuits before it is read.
        withEnv({
          T3CODE_DESKTOP_UPDATE_REPOSITORY: "disabled",
          GITHUB_REPOSITORY: "radroid/t3code",
        }),
      );

      assert.isUndefined(config, "a publish config here means app-update.yml ships again");
    }),
  );

  it.effect("would have resolved one from GITHUB_REPOSITORY alone — the bug this replaced", () =>
    Effect.gen(function* () {
      const config = yield* resolveGitHubPublishConfig("latest").pipe(
        withEnv({ GITHUB_REPOSITORY: "radroid/t3code" }),
      );

      // Not a wish for the old behaviour: it pins WHY the empty-string attempt was insufficient, so
      // a future reader cannot conclude the hook above is redundant.
      assert.deepStrictEqual(config, {
        provider: "github",
        owner: "radroid",
        repo: "t3code",
        releaseType: "release",
      });
    }),
  );
});
