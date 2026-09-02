# Desktop bundle size and build time — measured

Issue #53 collected the optimization surface for the desktop release build and asked that the numbers
not be re-derived from scratch next time someone reads a build log. This is the measured version, and
it corrects the issue on several points. Every figure here comes from a local
`--platform mac --target dmg --arch arm64 --keep-stage` build at `136b3514f` (post-#71 rename),
measured from the packed `app.asar` rather than from the install tree.

**Re-measured across the #71 rename.** The first pass was measured at `e44bf26b8`, before the fork
renamed itself to Coil and before #58's dependency re-resolution and #92's retirement of the local
autobuild. Both builds were re-run on `136b3514f`: the packed asar is **byte-for-byte the same size on
both sides** (189.66 MiB / 14,765 files baseline, 99.02 MiB / 3,429 optimized), so the rename moved
none of this. Only the `.dmg` and `.zip` moved, by ~3 KB, which is the renamed product string. All 66
non-wildcard exclusion globs still match a package that is actually shipped, so none has gone stale.

## Result

|                                     | Baseline      | After         | Δ                       |
| ----------------------------------- | ------------- | ------------- | ----------------------- |
| `app.asar`                          | 189.66 MiB    | **99.02 MiB** | **−90.64 MiB (−47.8%)** |
| Files in the asar                   | 14,765        | **3,429**     | −11,336 (−76.8%)        |
| Source maps in the asar             | 67.55 MiB     | 11.94 MiB     | −55.61 MiB              |
| `.app` on disk                      | 425 MB        | 319 MB        | −106 MB                 |
| `.dmg`                              | 150,392,957 B | 129,226,158 B | −21.2 MB (−14.1%)       |
| `.zip` (what the updater downloads) | 144,592,118 B | 124,467,727 B | −20.1 MB (−13.9%)       |
| electron-builder phase              | ~126 s        | ~48 s         | −62%                    |
| Staged `vp install --prod`          | 12.6 s        | 4.4 s         | −65%                    |

The compressed artifacts fall by 14% rather than 48% because the bytes removed are text — source maps
and JavaScript compress extremely well, so they were cheap in the dmg and expensive in the asar. The
`.zip` figure is the one that matters per user: it is what the update relay serves on every release.

## Correction 1: the issue's size table was measuring disk allocation, not content

Issue #53 §3 lists `core-js` at "15 MB (3,684 files)". In the packed asar `core-js` is **1.25 MiB**.
Both numbers are right about different things: `du` reports _allocated blocks_, so 3,684 files on a
4 KiB-block filesystem occupy ~14.7 MB of disk while holding 1.25 MiB of content. Every many-small-files
package in that table is overstated the same way — `@clerk/shared` 6.6 MB → 3.14 MiB, `lodash` 4.9 MB →
1.35 MiB, `shiki` 3.8 MB → 0.57 MiB.

This is why the issue's headline hypothesis ("the `@clerk/clerk-js` transitive tree ≈ 25 MB, the single
largest cluster") was not the biggest win available. The cluster is real and worth 23.23 MiB, but it was
never the largest thing in the bundle.

## Correction 2: the largest item was source maps, which the issue does not mention

Source maps were **67.55 MiB across 2,680 files — 35.6% of the entire asar**. The breakdown:

|                                                   | Size      | Handling                              |
| ------------------------------------------------- | --------- | ------------------------------------- |
| Web renderer (`apps/server/dist/client/**`)       | 37.38 MiB | Not built: `T3CODE_WEB_SOURCEMAP=0`   |
| Third-party (`node_modules/**`)                   | 18.23 MiB | Excluded: `!**/node_modules/**/*.map` |
| Server bundle (`bin.mjs.map`)                     | 9.34 MiB  | **Kept**                              |
| Desktop main process (`main.cjs.map` and friends) | 2.60 MiB  | **Kept**                              |

Nothing reads a `.map` at runtime. Node only parses one under `--enable-source-maps`, and
`DesktopBackendConfiguration.ts` _passes NODE_OPTIONS through_ rather than setting it, so a shipped
build never asks. Renderer maps are DevTools-only.

The first-party maps are kept deliberately: ~12 MiB buys legible stack traces for our own code for any
operator who does export `NODE_OPTIONS=--enable-source-maps`. Third-party maps buy nothing.

`T3CODE_WEB_SOURCEMAP` is an **existing upstream variable** (`apps/web/vite.config.ts`), so the single
biggest win in the issue costs zero seam rows. Setting it is provably behaviour-preserving: all **385**
renderer JS chunks are byte-identical between the two builds after stripping the trailing
`//# sourceMappingURL=` comment, and the content hashes in their filenames do not move.

## Correction 3: `@shikijs/langs` was being shipped twice, and this was the dead copy

Issue #53 §3.3 left this open. The answer: `@pierre/diffs` is a production dependency of `apps/server`,
so the whole shiki tree installs, but the server imports exactly one subpath —
`@pierre/diffs/utils/parsePatchFiles`, in `apps/server/src/checkpointing/Diffs.ts` — and the server build
**bundles** it. `bin.mjs` contains the inlined helpers and has no `@pierre/*` import left; tree-shaking
means the shiki half never enters the bundle either.

The highlighting a user actually sees is the web client's own per-language chunks
(`apps/server/dist/client/assets/typescript-*.js`). Cutting `@pierre/diffs` orphans **50 packages**,
21.0 MiB / 2,944 files in the asar.

## Correction 4: the Clerk tree is renderer-only, and the argument is the sandbox

`@clerk/clerk-js` reaches the graph through `@clerk/electron`, which the main process genuinely depends
on. But the main process requires exactly two of that package's six entry points — the root and
`/storage` — and between them they require only `electron` and `electron-store`. The entries that pull
the browser SDK are `/react` and `/passkeys`, whose only importer is `apps/web/src/main.tsx`.

`apps/web` is compiled before the artifact is staged, and the renderer that runs it is created with
`sandbox: true, nodeIntegration: false` (`apps/desktop/src/window/DesktopWindow.ts`) — it has no module
resolution at all. Clerk's own `loadClerkJsScript` builds a jsDelivr URL, which is a network fetch, not
a `node_modules` lookup.

Cutting `@clerk/clerk-js`, `@clerk/react` and `@clerk/shared` orphans **16 packages**, 23.23 MiB /
6,722 files. Verified by execution, not just by reading: loading `@clerk/electron` and
`@clerk/electron/storage` from inside the optimized asar under `ELECTRON_RUN_AS_NODE` yields
`createClerkBridge`, `setupPasskeysMain` and `storage`, and the transitive module list touches none of
the excluded packages.

`@clerk/electron`, `@clerk/electron-passkeys` and its native binaries are **not** excluded — the first is
required by the main process and the others are staged deliberately by `stageClerkPasskeyNativeBinaries()`.
A test asserts this.

## Correction 5: `DESKTOP_FILE_EXCLUSIONS` is not fork-owned

Issue #53 §3 describes it as "a fork-owned constant" and recommends preferring it over
dependency-resolution changes. The mechanism recommendation is right; the reason given is not.
`scripts/build-desktop-artifact.ts` is upstream-owned, and the fork's entire diff on it was the
11-line `T3X_DESKTOP_APP_ID` hook from #70. The `@anthropic-ai/claude-agent-sdk-*` exclusion is
upstream's own code.

That matters because upstream's test asserts:

```ts
assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
]);
```

So any glob added to that array in place has to be added to that assertion too. Note what the reason is
**not**: since the #71 rename, `build-desktop-artifact.test.ts` already carries a fork row, so growing it
would not add a new one. The reason is that this list is **67 globs and will grow** — inline, every
future size fix becomes an edit to an upstream test assertion, in a file resolved by hand at every sync,
where the conflict is decided by re-reading 67 lines instead of one.

The fork therefore uses the shape #70 reached for the same file: a one-expression environment hook, with
the list in `scripts/coil/desktop-file-exclusions.mjs`. An unset environment packages precisely what
upstream packages, and upstream's `deepStrictEqual` keeps passing untouched.

**Do not export `T3X_DESKTOP_FILE_EXCLUSIONS` into a shell you then run tests in** — that upstream
assertion fails with an unhelpful 68-vs-1 array diff. The release workflow scopes it to the single build
step (a step output, not `$GITHUB_ENV`) for this reason. Since #92 retired the local autobuild, that
workflow is the only path that builds a shipping artifact, so it is the only place the variable is set.

## Correction 6: build time — the mac leg is not the critical path

The issue's §4 suggests raising `--concurrency-limit` and adding a pnpm store cache. Measured against
run [31557758315](https://github.com/radroid/t3code/actions/runs/31557758315), both are misdirected:

| Step                                | mac arm64   | Windows x64  |
| ----------------------------------- | ----------- | ------------ |
| Setup Vite+                         | 251 s       | 120 s        |
| Install Spectre-mitigated MSVC libs | —           | **442 s**    |
| Build desktop bundle (serialised)   | 58 s        | 48 s         |
| Build desktop artifact              | 199 s       | 399 s        |
| **Job total**                       | **9.6 min** | **17.5 min** |

- **The two legs run in parallel**, so release wall-clock is the Windows leg. Optimizing the mac leg
  buys nothing on the critical path.
- **`--concurrency-limit 1` is nearly free.** The serialised bundle build is 48–58 s. Raising the limit
  could save perhaps 20–30 s while re-opening the `STATUS_DLL_INIT_FAILED` crashes of #47.
  **Recommend leaving it alone** — the issue's framing of it as a meaningful wall-clock cost is wrong.
- **A pnpm store cache already exists.** `setup-vp`'s `cache: true` restores a **1,943 MB** cache, and
  the mac log shows `Cache hit` with `downloaded 0`. The 251 s is 94 s of restoring 1.9 GB plus ~145 s
  of pnpm linking 1,876 packages — not a cold store. There is nothing to add.
- **The real remaining target is the 442 s Spectre MSVC install** — 42% of the Windows leg and the
  single largest step in the pipeline. Untouched here because it cannot be verified without a Windows
  release run, and a release run publishes. See below.

What this PR does buy on time is coupled to the size work: file _count_ is what asar packing and dmg
compression cost, and that fell 76.8%.

## Deliberately not done

- **`playwright-core` (10.2 MiB).** Loaded via `require.resolve()` on a `const` in
  `PlaywrightInjectedRuntime.ts`. This is the trap the reachability tool's "mention" edge exists to
  catch; an import-only scan calls it dead.
- **`undici` (1.6 MiB).** Unreachable, but HTTP clients probe for it dynamically. Not worth a
  networking bug.
- **`@msgpackr-extract/*` native accelerators.** Loaded by an assembled path — the closure's one
  admitted blind spot.
- **`react-grab` and its CLI tree (~2 MiB, ~25 packages).** Bundled into `preview-pick-preload.cjs` and
  genuinely unreachable, so a legitimate candidate; left out because the win is small next to the
  glob count. Cutting it would also delete every package in the issue's §2 "genuine duplicate installs"
  (`onetime`, `mimic-fn`, `restore-cursor`), making that section moot without touching `pnpm.overrides`.
- **`pnpm.overrides` for the three duplicate installs (§2).** Confirmed trivial — a few dozen KB — and
  each override is a root-`package.json` edit with a recurring sync cost. The issue's own recommendation
  not to do this stands.
- **The Spectre MSVC install (442 s).** The biggest single win left. It exists because the staged
  `vp install --prod` runs native lifecycle scripts on Windows. Testing whether prebuilds now cover
  them needs a Windows release run, and `coil-release.yml` publishes on success, so it cannot be
  probed safely without a dry-run path. Filed as follow-up work rather than guessed at.

## Sync cost: one upstream file, strictly additive

The whole point of the env-hook shape is that this work adds **no new conflict surface**. Measured
against `upstream/main`:

|                              |                                                                       |
| ---------------------------- | --------------------------------------------------------------------- |
| Upstream-owned files touched | **1** (`scripts/build-desktop-artifact.ts`)                           |
| This issue's delta on it     | **+21 / −0** — strictly additive                                      |
| That file's total fork delta | +32 / −1, where the −1 is #70's pre-existing displacement             |
| New seam rows                | **0**                                                                 |
| New fork-owned files         | 8, in `scripts/coil/` and `docs/coil/` — paths upstream has never had |

So the additive-seam invariant that makes a clean sync mean anything still holds: no deletion count
moved, and the file count did not change. The only realistic conflict is a _textual_ one — upstream
adding its own entry to `DESKTOP_FILE_EXCLUSIONS` collides with the `...coilExtraFileExclusions,` line
that sits at the end of that array. That is a two-line resolution (keep both), and it is the smallest
footprint this mechanism admits.

Two things a sync could break silently, both guarded:

- **The hook is reverted.** `desktop-bundle-size.test.ts` asserts the expression and the splice are
  still present, so a sync that drops them fails a test rather than quietly shipping the unfiltered
  189.66 MiB bundle.
- **The graph changes under the globs.** A dependency the fork excludes becomes something the main
  process really imports. `verify-desktop-bundle.mjs` reads the packed artifact on both platforms and
  fails the release, naming the glob to fix.

## The two tools, and why there are two

`scripts/coil/desktop-bundle-reachability.mjs` — analysis. Reads the built bundles, follows two kinds of
edge (literal specifiers, and any string literal naming an installed package), and reports what nothing
can reach. Deliberately over-matches: a false "reachable" costs bytes, a false "unreachable" ships a
broken app. Run it against a staged build:

```sh
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --keep-stage
node scripts/coil/desktop-bundle-reachability.mjs --stage /path/to/t3code-desktop-mac-stage-XXXX/app
```

`scripts/coil/verify-desktop-bundle.mjs` — the release gate, run on both platforms before publish. Reads
the packed artifact and fails when anything the packaged bundles import is not loadable from it. It is
_stricter_ than the analyzer in the one way that matters: it blanks comments first, because
`@noble/hashes`'s bundled JSDoc contains `import { hmac } from '@noble/hashes/hmac'` inside an
`@example` block, and failing a good release over a comment is worse than useless. It also merges
`app.asar` with `app.asar.unpacked/`, without which every Windows release would fail — that platform
unpacks all of `node_modules`.

Two bugs found by testing the gate rather than trusting it, both recorded in its header:

- It originally read only the archive. On Windows `asarUnpack` puts the bundles _and_ all of
  `node_modules` on disk, so it would have failed every Windows release.
- It originally split findings by attribution — error if a fork glob named the package, warning
  otherwise. A negative test (a real build with a deliberately over-broad
  `!**/node_modules/effect/**/*`) produced a bundle that cannot start and the gate went **green**,
  because the bad glob arrived through the environment and matched nothing in the list. Severity is now
  unconditional; attribution only decides how actionable the error message is. That negative test is
  now a fixture test, along with a hand-written asar that pins the header offset arithmetic.

```sh
node scripts/coil/verify-desktop-bundle.mjs --verify-app release/mac-arm64/"T3 Coil (Alpha).app"
```
