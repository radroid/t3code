#!/usr/bin/env node
// Assembles t3x-latest.json from the per-platform asset descriptors each build leg uploaded.
//
// This runs in the `publish` job, which `needs: [build]` — so it only runs when EVERY matrix leg
// succeeded. That is deliberate: a half-platform release would give Windows users a toast pointing
// at an asset that does not exist.
//
// Deliberately .mjs, matching scripts/clean-tsgo-backups.mjs. It is glue that runs once in CI with
// no imports from the workspace, so it does not need to participate in typecheck.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const EXPECTED_PLATFORMS = ["darwin-arm64", "win32-x64"];

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value.trim();
}

const [inputDir, outputPath] = process.argv.slice(2);
if (!inputDir || !outputPath) {
  throw new Error("Usage: build-update-manifest.mjs <input-dir> <output-path>");
}

const sha = required("FULL_SHA");
const shortSha = required("SHORT_SHA");
const releaseTag = required("RELEASE_TAG");
const repository = required("REPOSITORY");
const version = required("VERSION");
const buildNumber = Number(required("RUN_NUMBER"));

// `run_id` identifies the run; `run_number` counts them. They are different numbers and only the
// former addresses a URL — using RUN_NUMBER here yields a confident 404. RUN_NUMBER already has a
// job above (it IS `buildNumber`), so the two are deliberately read from separate variables.
const runId = required("RUN_ID");
if (!/^[0-9]+$/u.test(runId)) throw new Error(`RUN_ID must be numeric, got "${runId}".`);
if (runId === String(buildNumber)) {
  // Cheap tripwire for the likely wiring mistake. github.run_id is a large opaque id and
  // github.run_number is a small counter, so equality means the workflow passed the same value to
  // both — and the run link would point at whatever run happens to have that id.
  throw new Error(
    `RUN_ID (${runId}) equals RUN_NUMBER — the workflow is passing github.run_number to both. ` +
      "The run link needs github.run_id.",
  );
}

// Newline-delimited commit subjects, newest first. Absent is legal: the range can genuinely be
// empty (a re-run of the same commit), and an empty list must not fail the release.
const changes = (process.env.CHANGES ?? "")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`FULL_SHA is not a 40-char sha: ${sha}`);
if (!/^[0-9a-f]{12}$/u.test(shortSha)) {
  // 12 exactly. It has to match `git rev-parse --short=12` in build-desktop-artifact.ts and
  // COMMIT_HASH_DISPLAY_LENGTH in DesktopAppIdentity.ts, because that is the value the running app
  // can read about itself. A different length here means the client compares two things that can
  // never be equal, and offers the same update forever.
  throw new Error(`SHORT_SHA must be exactly 12 hex characters, got "${shortSha}".`);
}
if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
  throw new Error(`RUN_NUMBER must be a positive integer, got "${process.env.RUN_NUMBER}".`);
}

// The version's counter and the manifest's ordering key are the same number by construction.
// Asserted rather than assumed: if they ever drift, the app would order updates by one value while
// displaying another, and "0.0.31-t3x.44 is installed" could be a build the client considers older
// than what it already has. Cheap check, silent failure if omitted.
if (!version.endsWith(`-t3x.${buildNumber}`)) {
  throw new Error(
    `VERSION "${version}" does not end with the build counter "-t3x.${buildNumber}". ` +
      "The release workflow must derive both from github.run_number.",
  );
}

const assets = NodeFS.readdirSync(inputDir)
  .filter((name) => name.startsWith("asset-") && name.endsWith(".json"))
  .map((name) => JSON.parse(NodeFS.readFileSync(NodePath.join(inputDir, name), "utf8")))
  .map((asset) => ({
    platform: asset.platform,
    file: asset.file,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${asset.file}`,
    sha256: asset.sha256,
    bytes: asset.bytes,
  }))
  .sort((left, right) => left.platform.localeCompare(right.platform));

const missing = EXPECTED_PLATFORMS.filter(
  (platform) => !assets.some((asset) => asset.platform === platform),
);
if (missing.length > 0) {
  throw new Error(`No asset descriptor found for: ${missing.join(", ")}.`);
}

for (const asset of assets) {
  if (!/^[0-9a-f]{64}$/u.test(asset.sha256 ?? "")) {
    throw new Error(`Asset ${asset.platform} has a malformed sha256: "${asset.sha256}".`);
  }
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
    throw new Error(`Asset ${asset.platform} has a malformed size: "${asset.bytes}".`);
  }
}

const manifest = {
  // The comparison key. 12 chars, matching t3codeCommitHash.
  shortSha,
  // Ordering. Not the commit and not a timestamp: the commit cannot express "newer" at all, and
  // on this fork main is force-pushed, so a released commit may not be an ancestor of main.
  buildNumber,
  // Display and traceability only. Never compared.
  sha,
  version,
  releaseTag,
  builtAt: new Date().toISOString(),
  // Omitted rather than emitted empty. The toast keys "show the disclosure" off the field being
  // present and non-empty, and `changes: []` would travel as a promise of a changelog that then
  // renders nothing.
  ...(changes.length > 0 ? { changes } : {}),
  runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
  assets,
};

NodeFS.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
