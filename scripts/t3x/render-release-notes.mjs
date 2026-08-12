/*
 * Renders the body of a t3x GitHub release from scripts/t3x/install-instructions.json.
 *
 * The release workflow used to carry this text inline, which made the release body the only
 * place the install steps existed — and the download page pointed at "the release notes" without
 * linking them, so a first-time reader could go from the landing page to an app macOS calls
 * damaged having never seen a release note. Both surfaces now render the same file (issue #72);
 * the other renderer is apps/coil-home/src/lib/install.ts.
 *
 * Usage:
 *   node scripts/t3x/render-release-notes.mjs --sha <full> [--short-sha <short>] [--repo-root <dir>]
 *
 * Writes markdown to stdout. It reads one JSON file and formats strings — no network, nothing
 * from the environment but the arguments — so the release workflow can treat a non-zero exit as
 * a bug in this file rather than as a reason to lose a build.
 *
 * `.mjs`, not `.ts`, on purpose: the publish job has no `setup-node` step, so it runs on whatever
 * Node the runner image ships. Type stripping needs 22.18+, and a release is far too expensive to
 * risk on a runner-image bump. Its sibling build-update-manifest.mjs is `.mjs` for the same reason.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// A literal ``` cannot appear inside a template literal — it closes it. Naming it keeps the
// renderer readable rather than sprinkling escapes through it.
const FENCE = "```";

/**
 * This file's repo root. Exported so callers — the CLI below, and the test — never have to
 * rediscover it from their own location, which is the kind of duplication that breaks when a
 * file moves one directory.
 */
export const REPO_ROOT = NodePath.resolve(HERE, "..", "..");

/** @param {string} repoRoot */
export function loadInstructions(repoRoot) {
  const file = NodePath.join(repoRoot, "scripts/t3x/install-instructions.json");
  return JSON.parse(NodeFS.readFileSync(file, "utf8"));
}

/**
 * The bundle name electron-builder actually produces, per resolveDesktopProductName in
 * scripts/build-desktop-artifact.ts. Read from disk so the test compares the cached copy in the
 * JSON against the real thing rather than against another copy of the same string.
 *
 * Only the test calls this. The publish job's checkout is sparse (`/scripts`, `/package.json`),
 * so apps/desktop/package.json is not even present when the notes are rendered.
 *
 * @param {string} repoRoot
 */
export function desktopProductName(repoRoot) {
  const file = NodePath.join(repoRoot, "apps/desktop/package.json");
  const pkg = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  return pkg.productName ?? "T3 Code";
}

/**
 * Substitutes into a command template: `{app}` is the bundle name, `{file}` the asset the reader
 * downloaded. An unresolved placeholder throws rather than shipping — a half-substituted command
 * still looks copy-pasteable, and the error it produces in a terminal reads like the reader's
 * mistake rather than ours.
 *
 * @param {string} template
 * @param {{ app: string, file: string }} values
 */
export function fillCommand(template, values) {
  const filled = template.replace(/\{app\}/gu, values.app).replace(/\{file\}/gu, values.file);
  const leftover = /\{(\w+)\}/u.exec(filled);
  if (leftover) {
    throw new Error(`Unknown placeholder {${leftover[1]}} in install command: ${template}`);
  }
  return filled;
}

/**
 * The asset name the release workflow stages, mirroring its
 * `staged/T3Code-${SHORT_SHA}-${ARCH}.${ASSET_EXT}`.
 *
 * @param {{ assetPlatform: string }} platform
 * @param {string} shortSha
 */
export function assetFileName(platform, shortSha) {
  const [os, arch] = platform.assetPlatform.split("-");
  return `T3Code-${shortSha}-${arch}.${os === "darwin" ? "dmg" : "exe"}`;
}

/** @param {{ instructions: any, sha: string, shortSha: string }} input */
export function renderReleaseNotes({ instructions, sha, shortSha }) {
  const lines = [
    `Automated fork build of \`${sha}\`.`,
    "",
    `${instructions.unsignedNote} Full instructions, with copy buttons, are on the download page: ${instructions.downloadPageUrl}`,
    "",
    "## Installing this build by hand",
    "",
    "The in-app updater does all of this for you. These steps are for a **first** install, and for any install after the updater itself stops working.",
  ];

  for (const platform of instructions.platforms) {
    const file = assetFileName(platform, shortSha);
    lines.push("", `### ${platform.name}`, "", `_${platform.support}_`, "");

    platform.steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}.** ${step.body}`);
      if (step.command) {
        const command = fillCommand(step.command, { app: instructions.appBundleName, file });
        // Indented three spaces so the fence stays inside the list item; GitHub renders a fence
        // at column 0 as a sibling of the list rather than a child of the step.
        const language = step.shell === "PowerShell" ? "powershell" : "sh";
        lines.push("", `   ${FENCE}${language}`, `   ${command}`, `   ${FENCE}`, "");
      }
    });

    if (platform.afterword) {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(platform.afterword);
    }
  }

  lines.push(
    "",
    "SHA-256 for every asset is in `t3x-latest.json` above.",
    "",
    "Design: `docs/superpowers/specs/2026-08-03-update-delivery-design.md`.",
    "",
  );

  return lines.join("\n");
}

/** @param {readonly string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const [flag, inline] = token.slice(2).split("=", 2);
    if (!flag) continue;
    if (inline !== undefined) {
      out[flag] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[flag] = next;
      i += 1;
    }
  }
  return out;
}

// Guarded so importing this from the test does not also run it. `import.meta.main` is Node 24+,
// and this file must run on older Node too — hence the argv comparison rather than the flag.
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args["repo-root"] ?? REPO_ROOT;
  const sha = args.sha;
  const shortSha = args["short-sha"] ?? sha?.slice(0, 7);
  if (!sha || !shortSha) {
    console.error("usage: render-release-notes.mjs --sha <full> [--short-sha <short>]");
    process.exit(2);
  }
  process.stdout.write(
    renderReleaseNotes({ instructions: loadInstructions(repoRoot), sha, shortSha }),
  );
}
