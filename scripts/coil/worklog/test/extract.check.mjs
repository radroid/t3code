// Tests for lib/extract.mjs — the incremental extraction cache.
//
// The assertion this file exists for is the no-double-read invariant: queue -> commit -> queue
// again must queue nothing and must not even ask for the session's material a second time. Close
// behind it are the two properties that keep the cost and the risk bounded — the materiality bar
// (in both directions) and the guarantee that no tool result and no absolute path survives into a
// slice. Every fixture is synthetic; the real ~/.t3 and ~/.claude are never touched.

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTest from "node:test";

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
import { dayWindow } from "../lib/format.mjs";
import { worklogPaths } from "../lib/paths.mjs";

const HOME = "/Users/tester";

// Passed wherever a test asserts on the exact warning list: without a redaction list `queue` says
// so, and that warning would otherwise drown the one under test.
const REDACTION = {
  alwaysRedact: ["Northwind Books"],
  replacements: { "Northwind Books": "a client" },
};

// The collected day, in local time — the same arithmetic `collect()` uses, so these fixtures hold
// in every timezone the suite might run in.
const DAY = "2026-08-10";
const WINDOW = dayWindow(DAY);
const HOUR_MS = 3_600_000;
/** An ISO stamp `hours` into the collected day (negative reaches back before it). */
const at = (hours) => new Date(WINDOW.start.getTime() + hours * HOUR_MS).toISOString();
const afterWindow = (hours) => new Date(WINDOW.end.getTime() + hours * HOUR_MS).toISOString();

let sandbox = "";
let roots = 0;
let bases = 0;
const savedHome = process.env.HOME;

NodeTest.before(() => {
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  // Nothing here resolves a default worklog root, but a bug that did must not be able to reach the
  // real home directory.
  process.env.HOME = NodePath.join(sandbox, "home");
  NodeFS.mkdirSync(process.env.HOME, { recursive: true });
});

NodeTest.after(() => {
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

// Verbatim from the shipping schema — the two tables the default loader reads. Building the real
// thing keeps the column set, the NOT NULLs and the ordering honest; the user's own database is
// never opened, and `bundle.config.t3BaseDirs` is what points the loader here.
const T3_SCHEMA = [
  `CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    , attachments_json TEXT)`,
  `CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    , sequence INTEGER)`,
];

/** A base dir holding a real state.sqlite with the given messages and tool activities. */
function newT3BaseDir({ threadId = "alpha", messages = [], activities = [] } = {}) {
  bases += 1;
  const baseDir = NodePath.join(sandbox, `t3-${bases}`);
  NodeFS.mkdirSync(baseDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "state.sqlite"));
  for (const statement of T3_SCHEMA) db.exec(statement);

  const insertMessage = db.prepare(
    `INSERT INTO projection_thread_messages
       (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 0, ?, ?)`,
  );
  messages.forEach((message, index) => {
    insertMessage.run(
      `m-${bases}-${index}`,
      threadId,
      message.role ?? "user",
      message.text,
      message.createdAt,
      message.createdAt,
    );
  });

  const insertActivity = db.prepare(
    `INSERT INTO projection_thread_activities
       (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
     VALUES (?, ?, NULL, 'neutral', 'tool.completed', 'Command run', ?, ?, ?)`,
  );
  activities.forEach((activity, index) => {
    insertActivity.run(
      `a-${bases}-${index}`,
      threadId,
      JSON.stringify({ detail: activity.detail, data: { toolName: "Bash" } }),
      activity.createdAt,
      index,
    );
  });

  db.close();
  return baseDir;
}

/** The bundle shape `collect()` emits, narrowed to what the default loader reads. */
function bundleFixture({ sessions, t3BaseDirs = [], repos = [] } = {}) {
  return {
    range: { from: DAY, to: DAY, days: [DAY], timezone: "local" },
    config: { t3BaseDirs, worklogRoot: null },
    sessions,
    git: { repos },
  };
}

function sliceTextOf(result, index = 0) {
  return NodeFS.readFileSync(result.queued[index].slicePath, "utf8");
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
        path: `${HOME}/Developer/t3code/scripts/coil/worklog/lib/extract.mjs`,
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
    artifacts: ["scripts/coil/worklog/lib/extract.mjs"],
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
      { detail: "Edit: scripts/coil/worklog/lib/extract.mjs", toolName: "Edit" },
    ],
    commits: [{ subject: "feat(t3x): add the extraction cache", shortSha: "abc1234" }],
    ...overrides,
  };
}

// --- extractPath / loadExtract ------------------------------------------------------------------

NodeTest.test(
  "extractPath keeps every session in <root>/extracts as one filesystem-safe file",
  () => {
    const root = newRoot();
    const paths = worklogPaths(root);

    NodeAssert.equal(extractPath(root, "t3-alpha"), NodePath.join(paths.extracts, "t3-alpha.json"));
    NodeAssert.equal(
      extractPath(paths, "t3-alpha"),
      NodePath.join(paths.extracts, "t3-alpha.json"),
    );

    // A key is attacker-shaped only by accident (it comes from a session id), but it still becomes a
    // filename, so traversal must be impossible.
    const hostile = extractPath(root, "cc-../../etc/passwd");
    NodeAssert.equal(NodePath.dirname(hostile), paths.extracts);
    NodeAssert.ok(!NodePath.basename(hostile).includes(NodePath.sep));
  },
);

NodeTest.test("loadExtract returns null for anything it cannot trust, and never throws", () => {
  const root = newRoot();
  const paths = worklogPaths(root);
  NodeFS.mkdirSync(paths.extracts, { recursive: true });

  const write = (key, text) => NodeFS.writeFileSync(extractPath(root, key), text, "utf8");

  NodeAssert.equal(loadExtract(root, "missing"), null);
  write("corrupt", "{ this is not json");
  NodeAssert.equal(loadExtract(root, "corrupt"), null);
  write("array", "[1, 2, 3]");
  NodeAssert.equal(loadExtract(root, "array"), null);
  write("future", JSON.stringify({ schemaVersion: 99, extract: payloadFixture() }));
  NodeAssert.equal(loadExtract(root, "future"), null);
  write(
    "hollow",
    JSON.stringify({ schemaVersion: 1, extract: { problem: "", approach: "", outcome: "" } }),
  );
  NodeAssert.equal(loadExtract(root, "hollow"), null);
  write(
    "no-extract",
    JSON.stringify({ schemaVersion: 1, cursor: { lastEventAt: "2026-08-10T15:00:00.000Z" } }),
  );
  NodeAssert.equal(loadExtract(root, "no-extract"), null);
  NodeAssert.equal(loadExtract(root, ""), null);
});

NodeTest.test("loadExtract normalises a partial file instead of trusting its shape", () => {
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
  NodeAssert.equal(loaded.sessionKey, "t3-alpha");
  // A missing cursor reads as "never read anything", which re-extracts once rather than skipping.
  NodeAssert.deepEqual(loaded.cursor, { lastEventAt: null, lastTurnId: null, turnsProcessed: 0 });
  NodeAssert.deepEqual(loaded.extract.artifacts, ["x"]);
  NodeAssert.equal(loaded.history.length, 1);
});

NodeTest.test("loadExtracts maps only the keys that have a usable file", () => {
  const root = newRoot();
  commitExtract({
    paths: root,
    sessionKey: "t3-alpha",
    extract: payloadFixture(),
    session: sessionFixture(),
  });

  const map = loadExtracts(root, ["t3-alpha", "t3-alpha", "cc-nothing", "", null]);
  NodeAssert.ok(map instanceof Map);
  NodeAssert.deepEqual([...map.keys()], ["t3-alpha"]);
  NodeAssert.equal(map.get("t3-alpha").extract.status, "shipped");
  NodeAssert.deepEqual([...loadExtracts(root, null).keys()], []);
});

// --- needsExtraction ------------------------------------------------------------------------------

NodeTest.test(
  "needsExtraction clears the materiality bar on files, tool activity, or two prompts",
  () => {
    const withFiles = needsExtraction(
      sessionFixture({ materiality: { turnsWithFiles: 1, toolActivities: 0, userPrompts: 0 } }),
      null,
    );
    NodeAssert.equal(withFiles.needed, true);
    NodeAssert.match(withFiles.reason, /first extraction/u);

    const withTools = needsExtraction(
      sessionFixture({
        files: [],
        materiality: { turnsWithFiles: 0, toolActivities: 3, userPrompts: 1 },
      }),
      null,
    );
    NodeAssert.equal(withTools.needed, true);

    const withPrompts = needsExtraction(
      sessionFixture({
        files: [],
        materiality: { turnsWithFiles: 0, toolActivities: 0, userPrompts: 2 },
      }),
      null,
    );
    NodeAssert.equal(withPrompts.needed, true);

    // The raw shapes both stores produce work without a `materiality` block.
    const rawClaudeSession = needsExtraction(
      { key: "cc-1", endedAt: "2026-08-10T15:00:00.000Z", promptCount: 1, toolUseCount: 9 },
      null,
    );
    NodeAssert.equal(rawClaudeSession.needed, true);

    // A bundle session carries no counts at all — only `files` and `turnCount`.
    const bundleShaped = needsExtraction(
      { key: "t3-1", endedAt: "2026-08-10T15:00:00.000Z", turnCount: 4, files: [], signals: [] },
      null,
    );
    NodeAssert.equal(bundleShaped.needed, true);
  },
);

NodeTest.test("needsExtraction takes the collector's verdict as a boost, never as a veto", () => {
  const thin = { key: "t3-1", endedAt: "2026-08-10T15:00:00.000Z", turnCount: 1, files: [] };

  NodeAssert.equal(needsExtraction(thin, null).needed, false);
  // The collector counted tool events this module cannot see, so it may add the session back.
  NodeAssert.equal(needsExtraction({ ...thin, needsExtraction: true }, null).needed, true);
  NodeAssert.equal(needsExtraction({ ...thin, material: true }, null).needed, true);
  // It may not take one away: a session with real material stays queued whatever the flag says.
  const material = sessionFixture({ needsExtraction: false, material: false });
  NodeAssert.equal(needsExtraction(material, null).needed, true);
  // And it can never re-open a cursor that has already passed the session's last event.
  const done = needsExtraction(sessionFixture({ needsExtraction: true }), {
    cursor: { lastEventAt: "2026-08-10T15:00:00.000Z" },
  });
  NodeAssert.equal(done.needed, false);
});

NodeTest.test("needsExtraction refuses a session below the bar and says why", () => {
  const thin = needsExtraction(
    sessionFixture({
      files: [],
      materiality: { turnsWithFiles: 0, toolActivities: 2, userPrompts: 1 },
    }),
    null,
  );
  NodeAssert.equal(thin.needed, false);
  NodeAssert.equal(thin.newEvents, 0);
  NodeAssert.match(thin.reason, /below the materiality bar/u);
  NodeAssert.match(thin.reason, /0 turns with files, 2 tool activities, 1 prompt/u);

  NodeAssert.deepEqual(needsExtraction(null, null), {
    needed: false,
    reason: "not a session",
    newEvents: 0,
  });
  NodeAssert.match(
    needsExtraction({ key: "t3-x", turnCount: 9 }, null).reason,
    /no timestamped events/u,
  );

  const excluded = needsExtraction(
    sessionFixture({ excluded: { reason: "t3code-driven", linkedTo: "thread-1" } }),
    null,
  );
  NodeAssert.equal(excluded.needed, false);
  NodeAssert.match(excluded.reason, /excluded \(t3code-driven\)/u);
});

NodeTest.test("needsExtraction compares against the cursor, not the calendar", () => {
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

  NodeAssert.equal(needsExtraction(session, atCursor).needed, false);
  NodeAssert.match(needsExtraction(session, atCursor).reason, /already extracted through/u);
  NodeAssert.equal(needsExtraction(session, ahead).needed, false);

  const resumed = needsExtraction(session, behind);
  NodeAssert.equal(resumed.needed, true);
  NodeAssert.equal(resumed.newEvents, 2);
  NodeAssert.match(resumed.reason, /2 new events since 2026-08-10T12:30:00.000Z/u);

  // An unparseable cursor is treated as no cursor at all rather than as "up to date".
  NodeAssert.equal(
    needsExtraction(session, { cursor: { lastEventAt: "not a date" } }).needed,
    true,
  );
});

// --- buildSlice -----------------------------------------------------------------------------------

NodeTest.test("buildSlice renders every section from the session's own material", () => {
  const slice = buildSlice(sessionFixture(), { ...inputFixture(), homeDir: HOME });

  for (const heading of [
    "## Session",
    "## Prompts",
    "## Assistant",
    "## Activity",
    "## Files",
    "## Commits",
  ]) {
    NodeAssert.ok(slice.includes(heading), `expected ${heading} in the slice`);
  }
  NodeAssert.ok(slice.includes("- title: Ship the worklog skill"));
  NodeAssert.ok(slice.includes("- branch: t3x/worklog"));
  NodeAssert.ok(slice.includes("- turns: 6"));
  NodeAssert.ok(slice.includes("- window: 2026-08-10T12:00:00.000Z -> 2026-08-10T15:00:00.000Z"));
  NodeAssert.ok(slice.includes("1. Build the extraction cache."));
  NodeAssert.ok(slice.includes("2. Cap the slice at 12k chars."));
  NodeAssert.ok(slice.includes("First reply: Starting with the cursor."));
  NodeAssert.ok(slice.includes("Last reply: Cap enforced by dropping sections."));
  NodeAssert.ok(slice.includes("- extract.mjs +120/-4"));
  NodeAssert.ok(slice.includes("- feat(t3x): add the extraction cache"));
  // The file's directory is a location; only the basename may travel.
  NodeAssert.ok(!slice.includes(HOME));
});

NodeTest.test(
  "buildSlice reduces deep paths to basenames but leaves owner/repo and branches alone",
  () => {
    const slice = buildSlice(sessionFixture(), {
      homeDir: HOME,
      activities: [
        { detail: "Edit: scripts/coil/worklog/lib/extract.mjs" },
        { detail: "Bash: git push origin t3x/worklog" },
        { detail: "Bash: gh pr list --repo radroid/t3code" },
      ],
    });

    NodeAssert.ok(slice.includes("- Edit: extract.mjs"));
    NodeAssert.ok(!slice.includes("scripts/coil/worklog/lib"));
    NodeAssert.ok(slice.includes("git push origin t3x/worklog"));
    NodeAssert.ok(slice.includes("--repo radroid/t3code"));
  },
);

NodeTest.test("buildSlice never lets a tool result or a secret out of an activity", () => {
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

  NodeAssert.ok(!slice.includes("SUPER-SECRET-RESULT-BLOB"));
  NodeAssert.ok(!slice.includes(["AKIA", "IOSFODNN7EXAMPLE"].join("")));
  NodeAssert.ok(!slice.includes(["ghp", "_abcdefghijklmnopqrstuvwxyz012345"].join("")));
  NodeAssert.ok(!slice.includes(HOME));
  // The shape of the work still survives the scrub, which is the point of a slice.
  NodeAssert.ok(slice.includes(".env"));
});

NodeTest.test("buildSlice applies the configured redaction terms", () => {
  const slice = buildSlice(sessionFixture({ title: "Northwind Books migration" }), {
    homeDir: HOME,
    messages: [{ role: "user", text: "Finish the Northwind Books import." }],
    redaction: {
      alwaysRedact: ["Northwind Books"],
      replacements: { "Northwind Books": "a client" },
    },
  });

  NodeAssert.ok(!slice.includes("Northwind Books"));
  NodeAssert.ok(slice.includes("a client"));
});

NodeTest.test("buildSlice caps prompts, prompt length, activity lines, and files", () => {
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

  NodeAssert.ok(slice.includes("12. prompt 11"));
  NodeAssert.ok(!slice.includes("13. prompt 12"));
  NodeAssert.ok(slice.includes("(3 later prompts omitted)"));

  const promptLine = slice.split("\n").find((line) => line.startsWith("1. prompt 0"));
  NodeAssert.equal(promptLine.length, "1. ".length + 1200);
  NodeAssert.ok(promptLine.endsWith("…"));

  const activityCount = slice.split("\n").filter((line) => line.startsWith("- Bash: step ")).length;
  NodeAssert.equal(activityCount, 40);
  NodeAssert.ok(slice.includes("(20 more distinct activities omitted)"));

  const fileCount = slice.split("\n").filter((line) => /^- file-\d+\.ts /u.test(line)).length;
  NodeAssert.equal(fileCount, 30);
  NodeAssert.ok(slice.includes("(10 more files omitted)"));
});

NodeTest.test(
  "buildSlice enforces maxChars by dropping low-value sections from the bottom up",
  () => {
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
    for (let index = 0; index < 30; index += 1)
      commits.push({ subject: `commit subject ${index}` });

    const options = { messages, activities, commits, homeDir: HOME };
    const capped = buildSlice(sessionFixture({ files }), options);

    NodeAssert.ok(capped.length <= 12_000, `slice was ${capped.length} chars`);
    NodeAssert.ok(capped.includes("## Session"));
    NodeAssert.ok(capped.includes("## Prompts"));
    NodeAssert.ok(capped.includes("## Assistant"));
    // Dropped bottom-up, and the note that says so sits above the prompts so truncation cannot eat it.
    const lines = capped.split("\n");
    const noteIndex = lines.indexOf("_Omitted to fit the size cap: Commits, Files, Activity._");
    NodeAssert.notEqual(noteIndex, -1);
    NodeAssert.ok(noteIndex < lines.indexOf("## Prompts"));
    NodeAssert.ok(!capped.includes("commit subject 0"));
    NodeAssert.ok(!capped.includes("long-file-name-0.ts"));
    NodeAssert.ok(!capped.includes("a long command number 0"));
    NodeAssert.ok(!capped.endsWith("[slice truncated to fit the size cap]"));

    // Below the size of the two pinned sections there is nothing left to drop, so it truncates.
    const tiny = buildSlice(sessionFixture({ files }), { ...options, maxChars: 900 });
    NodeAssert.ok(tiny.length <= 900, `slice was ${tiny.length} chars`);
    NodeAssert.ok(tiny.endsWith("[slice truncated to fit the size cap]"));
    NodeAssert.ok(
      tiny.includes("_Omitted to fit the size cap: Commits, Files, Activity, Assistant._"),
    );
  },
);

NodeTest.test("buildSlice degrades instead of throwing", () => {
  NodeAssert.equal(typeof buildSlice(null, null), "string");
  NodeAssert.equal(typeof buildSlice(undefined), "string");
  NodeAssert.equal(
    buildSlice(sessionFixture(), { messages: "not an array" }).includes("## Session"),
    true,
  );
});

NodeTest.test("buildSlice falls back to a Claude Code session's own prompts", () => {
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
  NodeAssert.ok(slice.includes("1. Set up the release relay."));
  NodeAssert.ok(slice.includes("2. Ship it."));
});

// --- queue / commitExtract ------------------------------------------------------------------------

NodeTest.test("no message is ever read twice: queue -> commit -> queue queues nothing", () => {
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

  const first = queue({ bundle, paths: root, deps, redaction: REDACTION });
  NodeAssert.deepEqual(first.warnings, []);
  NodeAssert.equal(first.queued.length, 2);
  NodeAssert.deepEqual(first.skipped, []);
  NodeAssert.deepEqual(
    calls.map((call) => call.afterIso),
    [null, null],
  );
  for (const entry of first.queued) {
    NodeAssert.ok(NodeFS.existsSync(entry.slicePath));
    NodeAssert.equal(NodePath.dirname(entry.slicePath), worklogPaths(root).slices);
    NodeAssert.ok(NodeFS.readFileSync(entry.slicePath, "utf8").includes("## Session"));
    NodeAssert.ok(entry.newEvents >= 1);
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

  const second = queue({ bundle, paths: root, deps, redaction: REDACTION });
  NodeAssert.deepEqual(second.queued, []);
  NodeAssert.equal(second.skipped.length, 2);
  for (const entry of second.skipped) NodeAssert.match(entry.reason, /already extracted through/u);
  // The real proof: the second run never asked for the material at all.
  NodeAssert.equal(calls.length, 2);

  // New events after the cursor put the session back in the queue, reading only what is new.
  alpha.endedAt = "2026-08-10T18:00:00.000Z";
  const third = queue({ bundle, paths: root, deps, redaction: REDACTION });
  NodeAssert.deepEqual(
    third.queued.map((entry) => entry.sessionKey),
    ["t3-alpha"],
  );
  NodeAssert.equal(calls.length, 3);
  NodeAssert.equal(calls[2].afterIso, "2026-08-10T15:00:00.000Z");
});

NodeTest.test("queue orders by material value and honours the per-run limit", () => {
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
  NodeAssert.deepEqual(
    all.queued.map((entry) => entry.sessionKey),
    ["t3-big-edit", "t3-small-edit", "t3-chatty"],
  );

  const capped = queue({ bundle: { sessions }, paths: root, limit: 2 });
  NodeAssert.deepEqual(
    capped.queued.map((entry) => entry.sessionKey),
    ["t3-big-edit", "t3-small-edit"],
  );
  NodeAssert.deepEqual(capped.skipped, [
    {
      sessionKey: "t3-chatty",
      title: "Ship the worklog skill",
      projectKey: "t3code",
      reason: "over the per-run limit of 2",
    },
  ]);
});

NodeTest.test("queue skips immaterial and excluded sessions, and reports the reason", () => {
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
  NodeAssert.deepEqual(
    result.queued.map((entry) => entry.sessionKey),
    ["t3-real"],
  );
  NodeAssert.deepEqual(result.skipped.map((entry) => entry.sessionKey).sort(), [
    "cc-linked",
    "t3-thin",
  ]);
  NodeAssert.ok(!NodeFS.existsSync(NodePath.join(worklogPaths(root).slices, "t3-thin.md")));
});

NodeTest.test(
  "queue degrades a missing bundle, a keyless session, and a failing loader into warnings",
  () => {
    const root = newRoot();

    const nothing = queue({ paths: root });
    NodeAssert.deepEqual(nothing.queued, []);
    NodeAssert.match(nothing.warnings[0], /No evidence bundle/u);

    const empty = queue({ bundle: { sessions: [] }, paths: root });
    NodeAssert.match(empty.warnings[0], /no sessions/u);

    const keyless = queue({ bundle: { sessions: [sessionFixture({ key: "" })] }, paths: root });
    NodeAssert.deepEqual(keyless.queued, []);
    NodeAssert.match(keyless.warnings[0], /no key/u);

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
    NodeAssert.equal(thrown.queued.length, 1);
    NodeAssert.match(thrown.warnings[0], /Could not read new material for t3-alpha/u);
    NodeAssert.ok(!thrown.warnings[0].includes(HOME));

    const async = queue({
      bundle: { sessions: [sessionFixture()] },
      paths: root,
      deps: { loadInput: async () => inputFixture() },
    });
    NodeAssert.equal(async.queued.length, 1);
    NodeAssert.match(async.warnings[0], /must be synchronous/u);
  },
);

NodeTest.test(
  "queue warns when it has no redaction list, and never takes one off the bundle",
  () => {
    const root = newRoot();
    // `collect()` emits no `redaction` field. The fallback that used to read `bundle.redaction` here
    // meant the configured terms were applied to exactly zero real slices — and said nothing.
    const bundle = {
      ...bundleFixture({ sessions: [sessionFixture({ title: "Northwind Books migration" })] }),
      redaction: REDACTION,
    };
    const deps = { loadInput: () => inputFixture() };

    const unwired = queue({ bundle, paths: root, deps });
    NodeAssert.equal(unwired.queued.length, 1);
    NodeAssert.ok(
      unwired.warnings.some((warning) => /No always-redact terms were supplied/u.test(warning)),
      `expected a redaction warning, got ${JSON.stringify(unwired.warnings)}`,
    );
    NodeAssert.ok(sliceTextOf(unwired).includes("Northwind Books"));

    const wired = queue({ bundle, paths: newRoot(), deps, redaction: REDACTION });
    NodeAssert.deepEqual(wired.warnings, []);
    const slice = sliceTextOf(wired);
    NodeAssert.ok(!slice.includes("Northwind Books"));
    NodeAssert.ok(slice.includes("a client"));
  },
);

// --- the default loader ---------------------------------------------------------------------------

NodeTest.test("the default loader bounds a first extraction to the collected window", () => {
  const root = newRoot();
  const t3BaseDirs = [
    newT3BaseDir({
      threadId: "alpha",
      messages: [
        { text: "Old day work: rewire the auth flow.", createdAt: at(-70) },
        { text: "Today: bound the extraction read.", createdAt: at(12) },
        { text: "Tomorrow: start the next thing.", createdAt: afterWindow(1) },
      ],
    }),
  ];
  const session = sessionFixture({ startedAt: at(12), endedAt: at(15) });

  const result = queue({
    bundle: bundleFixture({ sessions: [session], t3BaseDirs }),
    paths: root,
    redaction: REDACTION,
  });

  NodeAssert.deepEqual(result.warnings, []);
  const slice = sliceTextOf(result);
  NodeAssert.ok(slice.includes("Today: bound the extraction read."));
  // With only the cursor as a bound — null on a first run — the read starts at the beginning of
  // the thread, so a thread opened days ago gets summarised as today's work and cached that way.
  NodeAssert.ok(
    !slice.includes("Old day work"),
    "a message from before the window reached the slice",
  );
  NodeAssert.ok(!slice.includes("Tomorrow:"), "a message from after the window reached the slice");
});

NodeTest.test("the default loader will not let a stale cursor reach back past the window", () => {
  const root = newRoot();
  const t3BaseDirs = [
    newT3BaseDir({
      threadId: "alpha",
      messages: [
        { text: "Last week: draft the relay.", createdAt: at(-70) },
        { text: "Today: bound the extraction read.", createdAt: at(12) },
      ],
      activities: [
        { detail: "Bash: an old-day command", createdAt: at(-70) },
        { detail: "Bash: an in-window command", createdAt: at(13) },
      ],
    }),
  ];
  const session = sessionFixture({ startedAt: at(12), endedAt: at(15) });

  // A cursor from a week ago: the session has run for days, and only part of it has been read.
  commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture(),
    session: sessionFixture({ endedAt: at(-160) }),
  });

  const result = queue({
    bundle: bundleFixture({ sessions: [session], t3BaseDirs }),
    paths: root,
    redaction: REDACTION,
  });

  NodeAssert.deepEqual(
    result.queued.map((entry) => entry.sessionKey),
    ["t3-alpha"],
  );
  const slice = sliceTextOf(result);
  NodeAssert.ok(slice.includes("Today: bound the extraction read."));
  NodeAssert.ok(slice.includes("- Bash: an in-window command"));
  NodeAssert.ok(!slice.includes("Last week:"), "the cursor out-ranked the window for messages");
  NodeAssert.ok(
    !slice.includes("an old-day command"),
    "the cursor out-ranked the window for activity",
  );
});

NodeTest.test("the default loader gives a session only the commits inside its own window", () => {
  const root = newRoot();
  const session = {
    key: "cc-1",
    kind: "claude-code",
    projectKey: "t3code",
    title: "Relay retry hardening",
    firstPrompt: "Harden the relay notify.",
    lastPrompt: "Ship it.",
    startedAt: at(12),
    endedAt: at(15),
    turnCount: 4,
    files: [],
  };
  const repos = [
    {
      key: "t3code",
      projectKey: "t3code",
      commits: [
        { sha: "aaa", at: at(9), subject: "chore: an earlier session's commit" },
        { sha: "bbb", at: at(13), subject: "feat: the session's own commit" },
        { sha: "ccc", at: at(15.08), subject: "docs: committed right after the last event" },
        { sha: "ddd", at: at(16), subject: "fix: a later session's commit" },
      ],
    },
  ];

  const result = queue({
    bundle: bundleFixture({ sessions: [session], repos }),
    paths: root,
    redaction: REDACTION,
  });

  const slice = sliceTextOf(result);
  NodeAssert.ok(slice.includes("feat: the session's own commit"));
  // A commit is usually the last thing that happens after the final recorded event, so a short
  // grace keeps it; everything else belongs to some other session's story.
  NodeAssert.ok(slice.includes("docs: committed right after the last event"));
  NodeAssert.ok(!slice.includes("an earlier session's commit"));
  NodeAssert.ok(!slice.includes("a later session's commit"));

  // With no window to judge against there is nothing to narrow by, so the evidence is kept.
  const undated = queue({
    bundle: bundleFixture({
      sessions: [{ ...session, key: "cc-2", startedAt: null, endedAt: null, lastEventAt: at(15) }],
      repos,
    }),
    paths: newRoot(),
    redaction: REDACTION,
  });
  NodeAssert.ok(sliceTextOf(undated).includes("chore: an earlier session's commit"));
});

NodeTest.test(
  "the default loader says so when a Claude Code session carries no prompt text",
  () => {
    const root = newRoot();
    const quiet = {
      key: "cc-quiet",
      kind: "claude-code",
      projectKey: "t3code",
      title: "A terminal day",
      startedAt: at(9),
      endedAt: at(11),
      turnCount: 3,
      files: [],
      signals: ["Bash: pnpm test"],
    };

    const result = queue({
      bundle: bundleFixture({ sessions: [quiet] }),
      paths: root,
      redaction: REDACTION,
    });
    NodeAssert.deepEqual(
      result.queued.map((entry) => entry.sessionKey),
      ["cc-quiet"],
    );
    NodeAssert.ok(
      result.warnings.some(
        (warning) => warning.includes("cc-quiet") && /No prompt text is recorded/u.test(warning),
      ),
      `expected a named warning, got ${JSON.stringify(result.warnings)}`,
    );

    const loud = queue({
      bundle: bundleFixture({
        sessions: [{ ...quiet, key: "cc-loud", firstPrompt: "Set up the release relay." }],
      }),
      paths: newRoot(),
      redaction: REDACTION,
    });
    NodeAssert.deepEqual(loud.warnings, []);
    NodeAssert.ok(sliceTextOf(loud).includes("1. Set up the release relay."));
  },
);

NodeTest.test("commitExtract writes the documented shape and advances the cursor", () => {
  const root = newRoot();
  const session = sessionFixture({ lastTurnId: "turn-6" });

  const { file, document } = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture({ status: "  Shipped  " }),
    session,
    now: "2026-08-10T16:00:00.000Z",
  });

  NodeAssert.equal(file, extractPath(root, "t3-alpha"));
  NodeAssert.ok(file.startsWith(root));
  NodeAssert.deepEqual(document, {
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
      artifacts: ["scripts/coil/worklog/lib/extract.mjs"],
      status: "shipped",
    },
    history: [],
  });
  NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(file, "utf8")), document);
});

NodeTest.test(
  "commitExtract scrubs the title it writes, because publish git-adds this file",
  () => {
    const root = newRoot();
    const { file, document } = commitExtract({
      paths: root,
      sessionKey: "t3-alpha",
      extract: payloadFixture(),
      session: sessionFixture({
        title: `Northwind Books import at ${HOME}/Developer/clients/import.ts`,
      }),
      homeDir: HOME,
      redaction: REDACTION,
    });

    // A thread title is model-generated from the work itself, so it carries whatever the work was
    // about — a client's name, the path being edited.
    NodeAssert.equal(document.title, "a client import at import.ts");
    const onDisk = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    NodeAssert.equal(onDisk.title, "a client import at import.ts");
    NodeAssert.ok(!onDisk.title.includes(HOME));
  },
);

NodeTest.test("commitExtract never rewinds a cursor", () => {
  const root = newRoot();
  const session = sessionFixture();
  commitExtract({ paths: root, sessionKey: session.key, extract: payloadFixture(), session });

  const older = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture({ outcome: "re-ran an older range" }),
    session: sessionFixture({ endedAt: "2026-08-09T09:00:00.000Z", turnCount: 3 }),
  });
  NodeAssert.equal(older.document.cursor.lastEventAt, "2026-08-10T15:00:00.000Z");
  NodeAssert.equal(older.document.cursor.turnsProcessed, 6);

  const newer = commitExtract({
    paths: root,
    sessionKey: session.key,
    extract: payloadFixture(),
    session: sessionFixture({ endedAt: "2026-08-11T09:00:00.000Z", turnCount: 2 }),
  });
  NodeAssert.equal(newer.document.cursor.lastEventAt, "2026-08-11T09:00:00.000Z");
  NodeAssert.equal(newer.document.cursor.turnsProcessed, 8);
});

NodeTest.test("commitExtract keeps the last 20 prior outcomes in history", () => {
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
  NodeAssert.equal(stored.extract.outcome, "outcome 24");
  NodeAssert.equal(stored.history.length, 20);
  NodeAssert.equal(stored.history[0].outcome, "outcome 4");
  NodeAssert.equal(stored.history[19].outcome, "outcome 23");
  NodeAssert.equal(stored.history[19].at, "2026-08-10T13:23:00.000Z");
});

NodeTest.test("commitExtract rejects each bad field with a message that names it", () => {
  const root = newRoot();
  const session = sessionFixture();
  const reject = (overrides, pattern) => {
    NodeAssert.throws(
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
  reject(
    { artifacts: Array.from({ length: 13 }, () => "a.ts") },
    /"artifacts" has 13 entries; the limit is 12/u,
  );
  reject({ artifacts: ["a.ts", 7] }, /"artifacts\[1\]" must be non-empty text/u);
  reject(
    { status: "done" },
    /"status" must be one of shipped, in-progress, blocked, abandoned, exploration/u,
  );
  reject({ status: undefined }, /"status" must be one of/u);

  NodeAssert.throws(
    () => commitExtract({ paths: root, sessionKey: "t3-alpha", extract: "not an object", session }),
    /expected an object with problem, approach, outcome, artifacts and status/u,
  );
  NodeAssert.throws(
    () => commitExtract({ paths: root, extract: payloadFixture(), session: {} }),
    /needs a sessionKey/u,
  );

  // Every violation is reported at once, so a subagent reply is fixed in one round trip.
  NodeAssert.throws(
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
  NodeAssert.equal(loadExtract(root, "t3-alpha"), null);
});

NodeTest.test("commitExtract accepts an omitted artifacts list as none", () => {
  const root = newRoot();
  const payload = payloadFixture();
  delete payload.artifacts;
  const { document } = commitExtract({
    paths: root,
    sessionKey: "t3-alpha",
    extract: payload,
    session: sessionFixture(),
  });
  NodeAssert.deepEqual(document.extract.artifacts, []);
});

// --- parseExtractPayload --------------------------------------------------------------------------

NodeTest.test(
  "parseExtractPayload recovers an object from every shape a subagent replies in",
  () => {
    const expected = {
      problem: "p",
      approach: "a",
      outcome: "o",
      artifacts: ["x.ts"],
      status: "shipped",
    };
    const json = JSON.stringify(expected);

    NodeAssert.deepEqual(parseExtractPayload(json), expected);
    NodeAssert.deepEqual(parseExtractPayload(`\n  ${json}\n`), expected);
    NodeAssert.deepEqual(parseExtractPayload("```json\n" + json + "\n```"), expected);
    NodeAssert.deepEqual(parseExtractPayload("```\n" + json + "\n```"), expected);
    NodeAssert.deepEqual(
      parseExtractPayload(
        `Here is the extract you asked for:\n\n\`\`\`json\n${json}\n\`\`\`\n\nHope that helps!`,
      ),
      expected,
    );
    NodeAssert.deepEqual(parseExtractPayload(`Sure — ${json} — done.`), expected);
    // Trailing prose containing its own brace defeats a naive first-{ to last-} slice.
    NodeAssert.deepEqual(
      parseExtractPayload(`Result: ${json}\nNote: a closing brace } in prose.`),
      expected,
    );
    // A brace inside a string value must not be treated as structure.
    NodeAssert.deepEqual(
      parseExtractPayload(`Reply: {"problem":"fix the } brace","status":"shipped"} thanks`),
      {
        problem: "fix the } brace",
        status: "shipped",
      },
    );
  },
);

NodeTest.test("parseExtractPayload fails loudly when there is no object to recover", () => {
  NodeAssert.throws(() => parseExtractPayload(""), /was empty/u);
  NodeAssert.throws(() => parseExtractPayload("   \n "), /was empty/u);
  NodeAssert.throws(() => parseExtractPayload(null), /was empty/u);
  NodeAssert.throws(
    () => parseExtractPayload("I could not summarise this session."),
    /Could not find a JSON object/u,
  );
  NodeAssert.throws(() => parseExtractPayload("[1, 2, 3]"), /Could not find a JSON object/u);
  NodeAssert.throws(
    () => parseExtractPayload("```json\n{ not json at all\n```"),
    /Could not find a JSON object/u,
  );
});

NodeTest.test("a parsed reply flows straight into commitExtract", () => {
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
  NodeAssert.equal(document.extract.status, "shipped");
  NodeAssert.deepEqual(document.extract.artifacts, ["PR #66"]);
  NodeAssert.equal(loadExtract(root, "t3-alpha").extract.artifacts[0], "PR #66");
});
