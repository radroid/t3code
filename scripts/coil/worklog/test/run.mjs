#!/usr/bin/env node
// Runs the worklog suites: `node scripts/coil/worklog/test/run.mjs [name ...]`. Suites are
// `*.check.mjs` on purpose: vitest in `@t3tools/scripts` would collect `*.test.mjs` and fail with
// "No test suite found", and excluding the dir would mean editing upstream's vite.config.ts.

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
