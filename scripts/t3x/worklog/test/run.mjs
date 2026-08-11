#!/usr/bin/env node
// Runs the worklog suites: `node scripts/t3x/worklog/test/run.mjs [name ...]`.
//
// The suites are `*.check.mjs`, not `*.test.mjs`, and that is load-bearing. This directory sits
// inside the `@t3tools/scripts` workspace, whose `test` script is vitest — and vitest's default
// include pattern matches `*.test.mjs`. It would collect these files, execute them (node:test
// registers and runs its cases inline), find no vitest suite, and fail the package with
// "No test suite found in file". The alternative was excluding this directory in the repo's
// upstream-owned vite.config.ts, which would have cost the fork a new seam-ledger row for a
// naming convention. Renaming is free.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const wanted = process.argv.slice(2);

const files = NodeFS.readdirSync(here)
  .filter((name) => name.endsWith(".check.mjs"))
  .filter((name) => wanted.length === 0 || wanted.some((want) => name.includes(want)))
  .sort()
  .map((name) => NodePath.join(here, name));

if (files.length === 0) {
  console.error(
    wanted.length === 0 ? "No suites found." : `No suite matches: ${wanted.join(", ")}`,
  );
  process.exit(2);
}

const result = NodeChildProcess.spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
