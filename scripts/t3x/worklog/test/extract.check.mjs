// Tests for lib/extract.mjs — the incremental extraction cache.
//
// The assertion this file exists for is the no-double-read invariant: queue -> commit -> queue
// again must queue nothing and must not even ask for the session's material a second time. Close
// behind it are the two properties that keep the cost and the risk bounded — the materiality bar
// (in both directions) and the guarantee that no tool result and no absolute path survives into a
// slice. Every fixture is synthetic; the real ~/.t3 and ~/.claude are never touched.

import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test, { after, before } from "node:test";

import {
  EXTRACT_SCHEMA_VERSION,
  buildSlice,
  commitExtract,
  extractPath,
  loadExtract,
  loadExtracts,
  needsExtraction,
  parseExtractPayload,
  queue,
} from "../lib/extract.mjs";
import { worklogPaths } from "../lib/paths.mjs";

const HOME = "/Users/tester";

let sandbox = "";
let roots = 0;
const savedHome = process.env.HOME;

before(() => {
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  // Nothing here resolves a default worklog root, but a bug that did must not be able to reach the
  // real home directory.
  process.env.HOME = NodePath.join(sandbox, "home");
  NodeFS.mkdirSync(process.env.HOME, { recursive: true });
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (sandbox !== "") NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

/** A fresh, empty worklog root so no test can see another's extracts. */
function newRoot() {
  roots += 1;
  const root = NodePath.join(sandbox, `repo-${roots}`);
  NodeFS.mkdirSync(root, { recursive: true });
  return root;
}

function sessionFixture(overrides = {}) {
  return {
    key: "t3-alpha",
    kind: "t3code",
    projectKey: "t3code",
    title: "Ship the worklog skill",
    branch: "t3x/worklog",
    models: ["claude-opus-4-8"],
    startedAt: "2026-08-10T12:00:00.000Z",
    endedAt: "2026-08-10T15:00:00.000Z",
    turnCount: 6,
    files: [
      {
        path: `${HOME}/Developer/t3code/scripts/t3x/worklog/lib/extract.mjs`,
        additions: 120,
        deletions: 4,
      },
    ],
    materiality: { turnsWithFiles: 3, toolActivities: 12, userPrompts: 5 },
    excluded: null,
    ...overrides,
  };
}

function payloadFixture(overrides = {}) {
  return {
    problem: "The collector re-read every message on each run.",
    approach: "Added a per-session cursor and a materiality bar.",
    outcome: "A second run over the same day queues nothing.",
    artifacts: ["scripts/t3x/worklog/lib/extract.mjs"],
    status: "shipped",
    ...overrides,
  };
}

function inputFixture(overrides = {}) {
  return {
    messages: [
      { role: "user", text: "Build the extraction cache.", createdAt: "2026-08-10T12:00:00.000Z" },
      {
        role: "assistant",
        text: "Starting with the cursor.",
        createdAt: "2026-08-10T12:01:00.000Z",
      },
      { role: "user", text: "Cap the slice at 12k chars.", createdAt: "2026-08-10T13:00:00.000Z" },
      {
        role: "assistant",
        text: "Cap enforced by dropping sections.",
        createdAt: "2026-08-10T14:00:00.000Z",
      },
    ],
    activities: [
      { detail: "Bash: node --test test/extract.test.mjs", toolName: "Bash" },
      { detail: "Edit: scripts/t3x/worklog/lib/extract.mjs", toolName: "Edit" },
    ],
    commits: [{ subject: "feat(t3x): add the extraction cache", shortSha: "abc1234" }],
    ...overrides,
  };
}

// --- extractPath / loadExtract ------------------------------------------------------------------

test("extractPath keeps every session in <root>/extracts as one filesystem-safe file", () => {
  const root = newRoot();
  const paths = worklogPaths(root);

  assert.equal(extractPath(root, "t3-alpha"), NodePath.join(paths.extracts, "t3-alpha.json"));
  assert.equal(extractPath(paths, "t3-alpha"), NodePath.join(paths.extracts, "t3-alpha.json"));

  // A key is attacker-shaped only by accident (it comes from a session id), but it still becomes a
  // filename, so traversal must be impossible.
  const hostile = extractPath(root, "cc-../../etc/passwd");
  assert.equal(NodePath.dirname(hostile), paths.extracts);
  assert.ok(!NodePath.basename(hostile).includes(NodePath.sep));
});

test("loadExtract returns null for anything it cannot trust, and never throws", () => {
  const root = newRoot();
  const paths = worklogPaths(root);
  NodeFS.mkdirSync(paths.extracts, { recursive: true });

  const write = (key, text) => NodeFS.writeFileSync(extractPath(root, key), text, "utf8");

  assert.equal(loadExtract(root, "missing"), null);
  write("corrupt", "{ this is not json");
  assert.equal(loadExtract(root, "corrupt"), null);
  write("array", "[1, 2, 3]");
  assert.equal(loadExtract(root, "array"), null);
  write("future", JSON.stringify({ schemaVersion: 99, extract: payloadFixture() }));
  assert.equal(loadExtract(root, "future"), null);
  write(
    "hollow",
    JSON.stringify({ schemaVersion: 1, extract: { problem: "", approach: "", outcome: "" } }),
  );
  assert.equal(loadExtract(root, "hollow"), null);
  write(
    "no-extract",
    JSON.stringify({ schemaVersion: 1, cursor: { lastEventAt: "2026-08-10T15:00:00.000Z" } }),
  );
  assert.equal(loadExtract(root, "no-extract"), null);
  assert.equal(loadExtract(root, ""), null);
});

test("loadExtract normalises a partial file instead of trusting its shape", () => {
  const root = newRoot();
  NodeFS.mkdirSync(worklogPaths(root).extracts, { recursive: true });
  NodeFS.writeFileSync(
    extractPath(root, "t3-alpha"),
    JSON.stringify({
      schemaVersion: 1,
      sessionKey: "t3-alpha",
      extract: {
        problem: "p",
        approach: "a",
        outcome: "o",
        artifacts: ["x", 7],
        status: "shipped",
      },
      history: [{ at: "2026-08-09T10:00:00.000Z", outcome: "older" }, "junk"],
    }),
    "utf8",
  );

  const loaded = loadExtract(root, "t3-alpha");
  assert.equal(loaded.sessionKey, "t3-alpha");
  // A missing cursor reads as "never read anything", which re-extracts once rather than skipping.
  assert.deepEqual(loaded.cursor, { lastEventAt: null, lastTurnId: null, turnsProcessed: 0 });
  assert.deepEqual(loaded.extract.artifacts, ["x"]);
  assert.equal(loaded.history.length, 1);
});

test("loadExtracts maps only the keys that have a usable file", () => {
  const root = newRoot();
  commitExtract({
    paths: root,
    sessionKey: "t3-alpha",
    extract: payloadFixture(),
    session: sessionFixture(),
  });

  const map = loadExtracts(root, ["t3-alpha", "t3-alpha", "cc-nothing", "", null]);
  assert.ok(map instanceof Map);
  assert.deepEqual([...map.keys()], ["t3-alpha"]);
  assert.equal(map.get("t3-alpha").extract.status, "shipped");
  assert.deepEqual([...loadExtracts(root, null).keys()], []);
});

// --- needsExtraction ------------------------------------------------------------------------------

test("needsExtraction clears the materiality bar on files, tool activity, or two prompts", () => {
  const withFiles = needsExtraction(
    sessionFixture({ materiality: { turnsWithFiles: 1, toolActivities: 0, userPrompts: 0 } }),
    null,
  );
  assert.equal(withFiles.needed, true);
  assert.match(withFiles.reason, /first extraction/u);

  const withTools = needsExtraction(
    sessionFixture({
      files: [],
      materiality: { turnsWithFiles: 0, toolActivities: 3, userPrompts: 1 },
    }),
    null,
  );
  assert.equal(withTools.needed, true);

  const withPrompts = needsExtraction(
    sessionFixture({
      files: [],
      materiality: { turnsWithFiles: 0, toolActivities: 0, userPrompts: 2 },
    }),
    null,
  );
  assert.equal(withPrompts.needed, true);

  // The raw shapes both stores produce work without a `materiality` block.
  const rawClaudeSession = needsExtraction(
    { key: "cc-1", endedAt: "2026-08-10T15:00:00.000Z", promptCount: 1, toolUseCount: 9 },
    null,
  );
  assert.equal(rawClaudeSession.needed, true);

  // A bundle session carries no counts at all — only `files` and `turnCount`.
  const bundleShaped = needsExtraction(
    { key: "t3-1", endedAt: "2026-08-10T15:00:00.000Z", turnCount: 4, files: [], signals: [] },
    null,
  );
  assert.equal(bundleShaped.needed, true);
});

test("needsExtraction takes the collector's verdict as a boost, never as a veto", () => {
  const thin = { key: "t3-1", endedAt: "2026-08-10T15:00:00.000Z", turnCount: 1, files: [] };

  assert.equal(needsExtraction(thin, null).needed, false);
  // The collector counted tool events this module cannot see, so it may add the session back.
  assert.equal(needsExtraction({ ...thin, needsExtraction: true }, null).needed, true);
  assert.equal(needsExtraction({ ...thin, material: true }, null).needed, true);
  // It may not take one away: a session with real material stays queued whatever the flag says.
  const material = sessionFixture({ needsExtraction: false, material: false });
  assert.equal(needsExtraction(material, null).needed, true);
  // And it can never re-open a cursor that has already passed the session's last event.
  const done = needsExtraction(sessionFixture({ needsExtraction: true }), {
    cursor: { lastEventAt: "2026-08-10T15:00:00.000Z" },
  });
  assert.equal(done.needed, false);
});

test("needsExtraction refuses a session below the bar and says why", () => {
  const thin = needsExtraction(
    sessionFixture({
      files: [],
      materiality: { turnsWithFiles: 0, toolActivities: 2, userPrompts: 1 },
    }),
    null,
  );
  assert.equal(thin.needed, false);
  assert.equal(thin.newEvents, 0);
  assert.match(thin.reason, /below the materiality bar/u);
  assert.match(thin.reason, /0 turns with files, 2 tool activities, 1 prompt/u);

  assert.deepEqual(needsExtraction(null, null), {
    needed: false,
    reason: "not a session",
    newEvents: 0,
  });
  assert.match(
    needsExtraction({ key: "t3-x", turnCount: 9 }, null).reason,
    /no timestamped events/u,
  );

  const excluded = needsExtraction(
    sessionFixture({ excluded: { reason: "t3code-driven", linkedTo: "thread-1" } }),
    null,
  );
  assert.equal(excluded.needed, false);
  assert.match(excluded.reason, /excluded \(t3code-driven\)/u);
});

test("needsExtraction compares against the cursor, not the calendar", () => {
  const session = sessionFixture({
    eventTimes: [
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T13:00:00.000Z",
      "2026-08-10T15:00:00.000Z",
    ],
  });
  const atCursor = { cursor: { lastEventAt: "2026-08-10T15:00:00.000Z" } };
  const behind = { cursor: { lastEventAt: "2026-08-10T12:30:00.000Z" } };
  const ahead = { cursor: { lastEventAt: "2026-08-11T09:00:00.000Z" } };

  assert.equal(needsExtraction(session, atCursor).needed, false);
  assert.match(needsExtraction(session, atCursor).reason, /already extracted through/u);
  assert.equal(needsExtraction(session, ahead).needed, false);

  const resumed = needsExtraction(session, behind);
  assert.equal(resumed.needed, true);
  assert.equal(resumed.newEvents, 2);
  assert.match(resumed.reason, /2 new events since 2026-08-10T12:30:00.000Z/u);

  // An unparseable cursor is treated as no cursor at all rather than as "up to date".
  assert.equal(needsExtraction(session, { cursor: { lastEventAt: "not a date" } }).needed, true);
});

// --- buildSlice -----------------------------------------------------------------------------------

test("buildSlice renders every section from the session's own material", () => {
  const slice = buildSlice(sessionFixture(), { ...inputFixture(), homeDir: HOME });

  for (const heading of [
    "## Session",
    "## Prompts",
    "## Assistant",
    "## Activity",
    "## Files",
    "## Commits",
  ]) {
    assert.ok(slice.includes(heading), `expected ${heading} in the slice`);
  }
  assert.ok(slice.includes("- title: Ship the worklog skill"));
  assert.ok(slice.includes("- branch: t3x/worklog"));
  assert.ok(slice.includes("- turns: 6"));
  assert.ok(slice.includes("- window: 2026-08-10T12:00:00.000Z -> 2026-08-10T15:00:00.000Z"));
  assert.ok(slice.includes("1. Build the extraction cache."));
  assert.ok(slice.includes("2. Cap the slice at 12k chars."));
  assert.ok(slice.includes("First reply: Starting with the cursor."));
  assert.ok(slice.includes("Last reply: Cap enforced by dropping sections."));
  assert.ok(slice.includes("- extract.mjs +120/-4"));
  assert.ok(slice.includes("- feat(t3x): add the extraction cache"));
  // The file's directory is a location; only the basename may travel.
  assert.ok(!slice.includes(HOME));
});

test("buildSlice reduces deep paths to basenames but leaves owner/repo and branches alone", () => {
  const slice = buildSlice(sessionFixture(), {
    homeDir: HOME,
    activities: [
      { detail: "Edit: scripts/t3x/worklog/lib/extract.mjs" },
      { detail: "Bash: git push origin t3x/worklog" },
      { detail: "Bash: gh pr list --repo radroid/t3code" },
    ],
  });

  assert.ok(slice.includes("- Edit: extract.mjs"));
  assert.ok(!slice.includes("scripts/t3x/worklog/lib"));
  assert.ok(slice.includes("git push origin t3x/worklog"));
  assert.ok(slice.includes("--repo radroid/t3code"));
});

test("buildSlice never lets a tool result or a secret out of an activity", () => {
  const slice = buildSlice(sessionFixture(), {
    homeDir: HOME,
    activities: [
      {
        detail: `Bash: cat ${HOME}/Developer/t3code/.env -> AKIAIOSFODNN7EXAMPLE`,
        toolName: "Bash",
        // The payload fields that carry full tool output. They must never be read.
        data: { result: "SUPER-SECRET-RESULT-BLOB", input: { command: "cat .env" } },
        result: "SUPER-SECRET-RESULT-BLOB",
      },
      { detail: `Bash: echo token ${["ghp", "_abcdefghijklmnopqrstuvwxyz012345"].join("")}` },
    ],
  });

  assert.ok(!slice.includes("SUPER-SECRET-RESULT-BLOB"));
  assert.ok(!slice.includes(["AKIA", "IOSFODNN7EXAMPLE"].join("")));
  assert.ok(!slice.includes(["ghp", "_abcdefghijklmnopqrstuvwxyz012345"].join("")));
  assert.ok(!slice.includes(HOME));
  // The shape of the work still survives the scrub, which is the point of a slice.
  assert.ok(slice.includes(".env"));
});

test("buildSlice applies the configured redaction terms", () => {
  const slice = buildSlice(sessionFixture({ title: "Northwind Books migration" }), {
    homeDir: HOME,
    messages: [{ role: "user", text: "Finish the Northwind Books import." }],
    redaction: {
      alwaysRedact: ["Northwind Books"],
      replacements: { "Northwind Books": "a client" },
    },
  });

  assert.ok(!slice.includes("Northwind Books"));
  assert.ok(slice.includes("a client"));
});

test("buildSlice caps prompts, prompt length, activity lines, and files", () => {
  const messages = [];
  for (let index = 0; index < 15; index += 1) {
    messages.push({ role: "user", text: `prompt ${index} ${"x".repeat(2000)}` });
  }
  const activities = [];
  for (let index = 0; index < 60; index += 1) activities.push({ detail: `Bash: step ${index}` });
  // A repeat of an earlier line is not new information.
  activities.push({ detail: "Bash: step 0" });
  const files = [];
  for (let index = 0; index < 40; index += 1) {
    files.push({
      path: `${HOME}/Developer/t3code/file-${index}.ts`,
      additions: index,
      deletions: 0,
    });
  }

  const slice = buildSlice(sessionFixture({ files }), {
    messages,
    activities,
    homeDir: HOME,
    maxChars: 200_000,
  });

  assert.ok(slice.includes("12. prompt 11"));
  assert.ok(!slice.includes("13. prompt 12"));
  assert.ok(slice.includes("(3 later prompts omitted)"));

  const promptLine = slice.split("\n").find((line) => line.startsWith("1. prompt 0"));
  assert.equal(promptLine.length, "1. ".length + 1200);
  assert.ok(promptLine.endsWith("…"));

  const activityCount = slice.split("\n").filter((line) => line.startsWith("- Bash: step ")).length;
  assert.equal(activityCount, 40);
  assert.ok(slice.includes("(20 more distinct activities omitted)"));

  const fileCount = slice.split("\n").filter((line) => /^- file-\d+\.ts /u.test(line)).length;
  assert.equal(fileCount, 30);
  assert.ok(slice.includes("(10 more files omitted)"));
});

test("buildSlice enforces maxChars by dropping low-value sections from the bottom up", () => {
  const messages = [];
  for (let index = 0; index < 6; index += 1) {
    messages.push({ role: "user", text: `prompt ${index} ${"y".repeat(1200)}` });
    messages.push({ role: "assistant", text: `reply ${index} ${"z".repeat(900)}` });
  }
  const activities = [];
  for (let index = 0; index < 40; index += 1) {
    activities.push({ detail: `Bash: a long command number ${index} ${"q".repeat(150)}` });
  }
  const files = [];
  for (let index = 0; index < 30; index += 1) {
    files.push({ path: `long-file-name-${index}.ts`, additions: 1, deletions: 1 });
  }
  const commits = [];
  for (let index = 0; index < 30; index += 1) commits.push({ subject: `commit subject ${index}` });

  const options = { messages, activities, commits, homeDir: HOME };
  const capped = buildSlice(sessionFixture({ files }), options);

  assert.ok(capped.length <= 12_000, `slice was ${capped.length} chars`);
  assert.ok(capped.includes("## Session"));
  assert.ok(capped.includes("## Prompts"));
  assert.ok(capped.includes("## Assistant"));
  // Dropped bottom-up, and the note that says so sits above the prompts so truncation cannot eat it.
  const lines = capped.split("\n");
  const noteIndex = lines.indexOf("_Omitted to fit the size cap: Commits, Files, Activity._");
  assert.notEqual(noteIndex, -1);
  assert.ok(noteIndex < lines.indexOf("## Prompts"));
  assert.ok(!capped.includes("commit subject 0"));
  assert.ok(!capped.includes("long-file-name-0.ts"));
  assert.ok(!capped.includes("a long command number 0"));
  assert.ok(!capped.endsWith("[slice truncated to fit the size cap]"));

  // Below the size of the two pinned sections there is nothing left to drop, so it truncates.
  const tiny = buildSlice(sessionFixture({ files }), { ...options, maxChars: 900 });
  assert.ok(tiny.length <= 900, `slice was ${tiny.length} chars`);
  assert.ok(tiny.endsWith("[slice truncated to fit the size cap]"));
  assert.ok(tiny.includes("_Omitted to fit the size cap: Commits, Files, Activity, Assistant._"));
});

test("buildSlice degrades instead of throwing", () => {
  assert.equal(typeof buildSlice(null, null), "string");
  assert.equal(typeof buildSlice(undefined), "string");
  assert.equal(
    buildSlice(sessionFixture(), { messages: "not an array" }).includes("## Session"),
    true,
  );
});

test("buildSlice falls back to a Claude Code session's own prompts", () => {
  const slice = buildSlice(
    {
      key: "cc-1",
      kind: "claude-code",
      firstPrompt: "Set up the release relay.",
      lastPrompt: "Ship it.",
      startedAt: "2026-08-10T09:00:00.000Z",
      endedAt: "2026-08-10T10:00:00.000Z",
    },
    { homeDir: HOME },
  );
  assert.ok(slice.includes("1. Set up the release relay."));
  assert.ok(slice.includes("2. Ship it."));
});

// --- queue / commitExtract ------------------------------------------------------------------------

test("no message is ever read twice: queue -> commit -> queue queues nothing", () => {
  const root = newRoot();
  const alpha = sessionFixture();
  const beta = sessionFixture({
    key: "t3-beta",
    title: "Relay retry hardening",
    files: [],
    turnCount: 2,
    materiality: { turnsWithFiles: 0, toolActivities: 5, userPrompts: 3 },
    endedAt: "2026-08-10T16:00:00.000Z",
  });
  const bundle = { sessions: [alpha, beta] };

  const calls = [];
  const deps = {
    loadInput: (session, context) => {
      calls.push({ key: session.key, afterIso: context.afterIso });
      return inputFixture();
    },
  };

  const first = queue({ bundle, paths: root, deps });
  assert.deepEqual(first.warnings, []);
  assert.equal(first.queued.length, 2);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(
    calls.map((call) => call.afterIso),
    [null, null],
  );
  for (const entry of first.queued) {
    assert.ok(NodeFS.existsSync(entry.slicePath));
    assert.equal(NodePath.dirname(entry.slicePath), worklogPaths(root).slices);
    assert.ok(NodeFS.readFileSync(entry.slicePath, "utf8").includes("## Session"));
    assert.ok(entry.newEvents >= 1);
  }

  const byKey = new Map([
    [alpha.key, alpha],
    [beta.key, beta],
  ]);
  for (const entry of first.queued) {
    commitExtract({
      paths: root,
      sessionKey: entry.sessionKey,
      extract: payloadFixture(),
      session: byKey.get(entry.sessionKey),
    });
  }

  const second = queue({ bundle, paths: root, deps });
  assert.deepEqual(second.queued, []);
  assert.equal(second.skipped.length, 2);
  for (const entry of second.skipped) assert.match(entry.reason, /already extracted through/u);
  // The real proof: the second run never asked for the material at all.
  assert.equal(calls.length, 2);

  // New events after the cursor put the session back in the queue, reading only what is new.
  alpha.endedAt = "2026-08-10T18:00:00.000Z";
  const third = queue({ bundle, paths: root, deps });
  assert.deepEqual(
    third.queued.map((entry) => entry.sessionKey),
    ["t3-alpha"],
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2].afterIso, "2026-08-10T15:00:00.000Z");
});

test("queue orders by material value and honours the per-run limit", () => {
  const root = newRoot();
  const sessions = [
    sessionFixture({
      key: "t3-chatty",
      files: [],
      turnCount: 20,
      materiality: { turnsWithFiles: 0, toolActivities: 9, userPrompts: 9 },
    }),
    sessionFixture({
      key: "t3-small-edit",
      turnCount: 1,
      materiality: { turnsWithFiles: 1, toolActivities: 1, userPrompts: 1 },
    }),
    sessionFixture({
      key: "t3-big-edit",
      turnCount: 9,
      materiality: { turnsWithFiles: 4, toolActivities: 9, userPrompts: 9 },
    }),
  ];

  const all = queue({ bundle: { sessions }, paths: worklogPaths(root), limit: 8 });
  assert.deepEqual(
    all.queued.map((entry) => entry.sessionKey),
    ["t3-big-edit", "t3-small-edit", "t3-chatty"],
  );

  const capped = queue({ bundle: { sessions }, paths: root, limit: 2 });
  assert.deepEqual(
    capped.queued.map((entry) => entry.sessionKey),
    ["t3-big-edit", "t3-small-edit"],
  );
  assert.deepEqual(capped.skipped, [
    {
      sessionKey: "t3-chatty",
      title: "Ship the worklog skill",
      projectKey: "t3code",
      reason: "over the per-run limit of 2",
    },
  ]);
});

test("queue skips immaterial and excluded sessions, and reports the reason", () => {
  const root = newRoot();
  const sessions = [
    sessionFixture({
      key: "t3-thin",
      files: [],
      materiality: { turnsWithFiles: 0, toolActivities: 1, userPrompts: 1 },
    }),
    sessionFixture({
      key: "cc-linked",
      excluded: { reason: "t3code-driven", linkedTo: "t3-alpha" },
    }),
    sessionFixture({ key: "t3-real" }),
  ];

  const result = queue({ bundle: { sessions }, paths: root });
  assert.deepEqual(
    result.queued.map((entry) => entry.sessionKey),
    ["t3-real"],
  );
  assert.deepEqual(result.skipped.map((entry) => entry.sessionKey).sort(), [
    "cc-linked",
    "t3-thin",
  ]);
  assert.ok(!NodeFS.existsSync(NodePath.join(worklogPaths(root).slices, "t3-thin.md")));
});

test("queue degrades a missing bundle, a keyless session, and a failing loader into warnings", () => {
  const root = newRoot();

  const nothing = queue({ paths: root });
  assert.deepEqual(nothing.queued, []);
  assert.match(nothing.warnings[0], /No evidence bundle/u);

  const empty = queue({ bundle: { sessions: [] }, paths: root });
  assert.match(empty.warnings[0], /no sessions/u);

  const keyless = queue({ bundle: { sessions: [sessionFixture({ key: "" })] }, paths: root });
  assert.deepEqual(keyless.queued, []);
  assert.match(keyless.warnings[0], /no key/u);

  const thrown = queue({
    bundle: { sessions: [sessionFixture()] },
    paths: root,
    deps: {
      loadInput: () => {
        throw new Error(`could not open ${HOME}/Developer/t3code/state.sqlite`);
      },
    },
  });
  // The session is still queued from what the bundle already knows, and the warning cannot leak
  // the path that failed.
  assert.equal(thrown.queued.length, 1);
  assert.match(thrown.warnings[0], /Could not read new material for t3-alpha/u);
  assert.ok(!thrown.warnings[0].includes(HOME));

  const async = queue({
    bundle: { sessions: [sessionFixture()] },
    paths: root,
    deps: { loadInput: async () => inputFixture() },
  });
  assert.equal(async.queued.length, 1);
  assert.match(async.warnings[0], /must be synchronous/u);
});

test("commitExtract writes the documented shape and advances the cursor", () => {
  const root = newRoot();
  const session = sessionFixture({ lastTurnId: "turn-6" });

  const { file, document } = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture({ status: "  Shipped  " }),
    session,
    now: "2026-08-10T16:00:00.000Z",
  });

  assert.equal(file, extractPath(root, "t3-alpha"));
  assert.ok(file.startsWith(root));
  assert.deepEqual(document, {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    sessionKey: "t3-alpha",
    kind: "t3code",
    projectKey: "t3code",
    title: "Ship the worklog skill",
    updatedAt: "2026-08-10T16:00:00.000Z",
    cursor: { lastEventAt: "2026-08-10T15:00:00.000Z", lastTurnId: "turn-6", turnsProcessed: 6 },
    extract: {
      problem: payloadFixture().problem,
      approach: payloadFixture().approach,
      outcome: payloadFixture().outcome,
      artifacts: ["scripts/t3x/worklog/lib/extract.mjs"],
      status: "shipped",
    },
    history: [],
  });
  assert.deepEqual(JSON.parse(NodeFS.readFileSync(file, "utf8")), document);
});

test("commitExtract never rewinds a cursor", () => {
  const root = newRoot();
  const session = sessionFixture();
  commitExtract({ paths: root, sessionKey: session.key, extract: payloadFixture(), session });

  const older = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture({ outcome: "re-ran an older range" }),
    session: sessionFixture({ endedAt: "2026-08-09T09:00:00.000Z", turnCount: 3 }),
  });
  assert.equal(older.document.cursor.lastEventAt, "2026-08-10T15:00:00.000Z");
  assert.equal(older.document.cursor.turnsProcessed, 6);

  const newer = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture(),
    session: sessionFixture({ endedAt: "2026-08-11T09:00:00.000Z", turnCount: 2 }),
  });
  assert.equal(newer.document.cursor.lastEventAt, "2026-08-11T09:00:00.000Z");
  assert.equal(newer.document.cursor.turnsProcessed, 8);
});

test("commitExtract keeps the last 20 prior outcomes in history", () => {
  const root = newRoot();
  const session = sessionFixture();

  for (let index = 0; index < 25; index += 1) {
    commitExtract({
      paths: root,
      sessionKey: session.key,
      extract: payloadFixture({ outcome: `outcome ${index}` }),
      session: sessionFixture({
        endedAt: new Date(Date.UTC(2026, 7, 10, 12, index)).toISOString(),
      }),
      now: new Date(Date.UTC(2026, 7, 10, 13, index)).toISOString(),
    });
  }

  const stored = loadExtract(root, session.key);
  assert.equal(stored.extract.outcome, "outcome 24");
  assert.equal(stored.history.length, 20);
  assert.equal(stored.history[0].outcome, "outcome 4");
  assert.equal(stored.history[19].outcome, "outcome 23");
  assert.equal(stored.history[19].at, "2026-08-10T13:23:00.000Z");
});

test("commitExtract rejects each bad field with a message that names it", () => {
  const root = newRoot();
  const session = sessionFixture();
  const reject = (overrides, pattern) => {
    assert.throws(
      () =>
        commitExtract({
          paths: root,
          sessionKey: "t3-alpha",
          extract: payloadFixture(overrides),
          session,
        }),
      pattern,
    );
  };

  reject({ problem: "   " }, /"problem" must not be empty/u);
  reject({ problem: 42 }, /"problem" must be text/u);
  reject({ approach: null }, /"approach" must be text/u);
  reject({ outcome: "x".repeat(601) }, /"outcome" is 601 characters; the limit is 600/u);
  reject({ artifacts: "one.ts" }, /"artifacts" must be an array of text entries/u);
  reject({ artifacts: new Array(13).fill("a.ts") }, /"artifacts" has 13 entries; the limit is 12/u);
  reject({ artifacts: ["a.ts", 7] }, /"artifacts\[1\]" must be non-empty text/u);
  reject(
    { status: "done" },
    /"status" must be one of shipped, in-progress, blocked, abandoned, exploration/u,
  );
  reject({ status: undefined }, /"status" must be one of/u);

  assert.throws(
    () => commitExtract({ paths: root, sessionKey: "t3-alpha", extract: "not an object", session }),
    /expected an object with problem, approach, outcome, artifacts and status/u,
  );
  assert.throws(
    () => commitExtract({ paths: root, extract: payloadFixture(), session: {} }),
    /needs a sessionKey/u,
  );

  // Every violation is reported at once, so a subagent reply is fixed in one round trip.
  assert.throws(
    () =>
      commitExtract({
        paths: root,
        sessionKey: "t3-alpha",
        extract: { problem: "", approach: 1, outcome: "ok", artifacts: 5, status: "nope" },
        session,
      }),
    (error) =>
      /"problem"/u.test(error.message) &&
      /"approach"/u.test(error.message) &&
      /"artifacts"/u.test(error.message) &&
      /"status"/u.test(error.message),
  );

  // Nothing was written by any rejected commit.
  assert.equal(loadExtract(root, "t3-alpha"), null);
});

test("commitExtract accepts an omitted artifacts list as none", () => {
  const root = newRoot();
  const payload = payloadFixture();
  delete payload.artifacts;
  const { document } = commitExtract({
    paths: root,
    sessionKey: "t3-alpha",
    extract: payload,
    session: sessionFixture(),
  });
  assert.deepEqual(document.extract.artifacts, []);
});

// --- parseExtractPayload --------------------------------------------------------------------------

test("parseExtractPayload recovers an object from every shape a subagent replies in", () => {
  const expected = {
    problem: "p",
    approach: "a",
    outcome: "o",
    artifacts: ["x.ts"],
    status: "shipped",
  };
  const json = JSON.stringify(expected);

  assert.deepEqual(parseExtractPayload(json), expected);
  assert.deepEqual(parseExtractPayload(`\n  ${json}\n`), expected);
  assert.deepEqual(parseExtractPayload("```json\n" + json + "\n```"), expected);
  assert.deepEqual(parseExtractPayload("```\n" + json + "\n```"), expected);
  assert.deepEqual(
    parseExtractPayload(
      `Here is the extract you asked for:\n\n\`\`\`json\n${json}\n\`\`\`\n\nHope that helps!`,
    ),
    expected,
  );
  assert.deepEqual(parseExtractPayload(`Sure — ${json} — done.`), expected);
  // Trailing prose containing its own brace defeats a naive first-{ to last-} slice.
  assert.deepEqual(
    parseExtractPayload(`Result: ${json}\nNote: a closing brace } in prose.`),
    expected,
  );
  // A brace inside a string value must not be treated as structure.
  assert.deepEqual(
    parseExtractPayload(`Reply: {"problem":"fix the } brace","status":"shipped"} thanks`),
    {
      problem: "fix the } brace",
      status: "shipped",
    },
  );
});

test("parseExtractPayload fails loudly when there is no object to recover", () => {
  assert.throws(() => parseExtractPayload(""), /was empty/u);
  assert.throws(() => parseExtractPayload("   \n "), /was empty/u);
  assert.throws(() => parseExtractPayload(null), /was empty/u);
  assert.throws(
    () => parseExtractPayload("I could not summarise this session."),
    /Could not find a JSON object/u,
  );
  assert.throws(() => parseExtractPayload("[1, 2, 3]"), /Could not find a JSON object/u);
  assert.throws(
    () => parseExtractPayload("```json\n{ not json at all\n```"),
    /Could not find a JSON object/u,
  );
});

test("a parsed reply flows straight into commitExtract", () => {
  const root = newRoot();
  const reply = [
    "Here's the extract:",
    "```json",
    JSON.stringify({
      problem: "The relay notify returned a 500 after committing.",
      approach: "Retried the notify and surfaced DO failures as 503s.",
      outcome: "A red notify no longer means an undelivered release.",
      artifacts: ["PR #66"],
      status: "shipped",
    }),
    "```",
  ].join("\n");

  const { document } = commitExtract({
    paths: root,
    sessionKey: "t3-alpha",
    extract: parseExtractPayload(reply),
    session: sessionFixture(),
  });
  assert.equal(document.extract.status, "shipped");
  assert.deepEqual(document.extract.artifacts, ["PR #66"]);
  assert.equal(loadExtract(root, "t3-alpha").extract.artifacts[0], "PR #66");
});
