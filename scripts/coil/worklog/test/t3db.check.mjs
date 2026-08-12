// Fixture-driven tests for lib/t3db.mjs.
//
// Every database here is built from scratch in a temp dir with the real `CREATE TABLE` statements
// from `~/.t3/userdata/state.sqlite`, so column sets, NOT NULL constraints, and defaults match
// production. The user's real databases are never opened.

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  closeDatabases,
  firstUserPromptsByThread,
  normalizePrompt,
  openT3Databases,
  promptHash,
  promptHashIndex,
  readActivities,
  readProjects,
  readThreadMessages,
  readThreads,
  readTurns,
  tokensByTask,
} from "../lib/t3db.mjs";

// Verbatim from the shipping schema.
const SCHEMA = [
  `CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      scripts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , default_model_selection_json TEXT, default_thread_env_mode TEXT, favicon_path TEXT)`,
  `CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      latest_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    , runtime_mode TEXT NOT NULL DEFAULT 'full-access', interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT, pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0, settled_override TEXT, settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, pinned_at TEXT, pin_order_key TEXT)`,
  `CREATE TABLE projection_turns (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      pending_message_id TEXT,
      assistant_message_id TEXT,
      state TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      checkpoint_turn_count INTEGER,
      checkpoint_ref TEXT,
      checkpoint_status TEXT,
      checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT,
      UNIQUE (thread_id, turn_id),
      UNIQUE (thread_id, checkpoint_turn_count)
    )`,
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
];

const DAY_START = "2026-08-10T04:00:00.000Z";
const DAY_END = "2026-08-11T04:00:00.000Z";
const WINDOW = { start: DAY_START, end: DAY_END };

const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
const openHandles = [];

NodeTest.after(() => {
  closeDatabases(openHandles.flat());
  NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
});

let fixtureCounter = 0;

/** Creates a base dir containing a fresh, schema-complete state.sqlite and returns a writer. */
function makeBaseDir(name) {
  const baseDir = NodePath.join(tmpRoot, `${name}-${(fixtureCounter += 1)}`);
  NodeFS.mkdirSync(baseDir, { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "state.sqlite"));
  for (const statement of SCHEMA) db.exec(statement);
  return { baseDir, db };
}

function insertProject(db, row) {
  db.prepare(
    `INSERT INTO projection_projects
       (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.projectId,
    row.title,
    row.workspaceRoot,
    "[]",
    row.createdAt ?? DAY_START,
    row.updatedAt ?? DAY_START,
    row.deletedAt ?? null,
  );
}

function insertThread(db, row) {
  db.prepare(
    `INSERT INTO projection_threads
       (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at,
        model_selection_json, archived_at, latest_user_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.threadId,
    row.projectId ?? "proj-1",
    row.title ?? "A thread",
    row.branch ?? null,
    row.worktreePath ?? null,
    row.createdAt,
    row.updatedAt,
    row.deletedAt ?? null,
    row.modelSelectionJson === undefined ? null : row.modelSelectionJson,
    row.archivedAt ?? null,
    row.latestUserMessageAt ?? null,
  );
}

function insertTurn(db, row) {
  db.prepare(
    `INSERT INTO projection_turns
       (thread_id, turn_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.threadId,
    row.turnId,
    row.state ?? "completed",
    row.requestedAt,
    row.startedAt ?? row.requestedAt,
    row.completedAt ?? null,
    row.checkpointFilesJson ?? "[]",
  );
}

let activitySeq = 0;

function insertActivity(db, row) {
  activitySeq += 1;
  db.prepare(
    `INSERT INTO projection_thread_activities
       (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.activityId ?? `act-${activitySeq}`,
    row.threadId,
    row.turnId ?? null,
    "neutral",
    row.kind,
    row.summary ?? "GENERIC-SUMMARY-LABEL",
    row.payloadJson,
    row.createdAt,
    row.sequence ?? activitySeq,
  );
}

let messageSeq = 0;

function insertMessage(db, row) {
  messageSeq += 1;
  db.prepare(
    `INSERT INTO projection_thread_messages
       (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.messageId ?? `msg-${messageSeq}`,
    row.threadId,
    row.turnId ?? null,
    row.role,
    row.text,
    0,
    row.createdAt,
    row.createdAt,
  );
}

/** Opens the given base dirs and registers the handles for teardown. */
function open(baseDirs) {
  const opened = openT3Databases(baseDirs);
  openHandles.push(opened.handles);
  return opened;
}

NodeTest.describe("openT3Databases", () => {
  NodeTest.it("skips absent databases silently and opens the ones that exist", () => {
    const alpha = makeBaseDir("open-alpha");
    alpha.db.close();
    const empty = NodePath.join(tmpRoot, "open-nothing-here");
    NodeFS.mkdirSync(empty, { recursive: true });

    const { handles, warnings } = open([alpha.baseDir, empty, "", null, undefined]);

    NodeAssert.equal(handles.length, 1);
    NodeAssert.equal(handles[0].baseDir, alpha.baseDir);
    NodeAssert.equal(handles[0].dbPath, NodePath.join(alpha.baseDir, "state.sqlite"));
    NodeAssert.ok(handles[0].db);
    NodeAssert.deepEqual(warnings, []);
  });

  NodeTest.it("warns instead of throwing when a state.sqlite exists but cannot be opened", () => {
    const broken = NodePath.join(tmpRoot, "open-broken");
    // A directory where the database should be: present on disk, impossible to open.
    NodeFS.mkdirSync(NodePath.join(broken, "state.sqlite"), { recursive: true });

    const { handles, warnings } = open([broken]);

    NodeAssert.deepEqual(handles, []);
    NodeAssert.equal(warnings.length, 1);
    NodeAssert.match(warnings[0], /state\.sqlite/u);
  });

  NodeTest.it("opens a database once even when two base dirs resolve to the same file", () => {
    const real = makeBaseDir("open-real");
    real.db.close();
    const link = NodePath.join(tmpRoot, "open-link");
    NodeFS.symlinkSync(real.baseDir, link, "dir");

    const { handles, warnings } = open([real.baseDir, link]);

    NodeAssert.equal(handles.length, 1, "a symlinked base dir must not double every row");
    NodeAssert.deepEqual(warnings, []);
  });

  NodeTest.it("tolerates a non-array argument", () => {
    NodeAssert.deepEqual(openT3Databases(undefined), { handles: [], warnings: [] });
    NodeAssert.deepEqual(openT3Databases("nope"), { handles: [], warnings: [] });
  });
});

NodeTest.describe("closeDatabases", () => {
  NodeTest.it("never throws, whatever it is handed", () => {
    NodeAssert.doesNotThrow(() => closeDatabases(undefined));
    NodeAssert.doesNotThrow(() => closeDatabases([null, {}, { db: {} }]));
    NodeAssert.doesNotThrow(() =>
      closeDatabases([
        {
          db: {
            close() {
              throw new Error("already closed");
            },
          },
        },
      ]),
    );
  });
});

NodeTest.describe("readProjects", () => {
  NodeTest.it("merges rows from every base dir and carries the source base dir", () => {
    const alpha = makeBaseDir("projects-alpha");
    insertProject(alpha.db, { projectId: "p-1", title: "t3code", workspaceRoot: "/tmp/a/t3code" });
    insertProject(alpha.db, {
      projectId: "p-2",
      title: "gone",
      workspaceRoot: "/tmp/a/gone",
      deletedAt: "2026-08-01T00:00:00.000Z",
    });
    alpha.db.close();

    const beta = makeBaseDir("projects-beta");
    insertProject(beta.db, { projectId: "p-3", title: "worklog", workspaceRoot: "/tmp/b/worklog" });
    beta.db.close();

    const { handles } = open([alpha.baseDir, beta.baseDir]);
    const projects = readProjects(handles);

    NodeAssert.deepEqual(
      projects.map((p) => [p.projectId, p.title, p.workspaceRoot, p.deletedAt]),
      [
        ["p-1", "t3code", "/tmp/a/t3code", null],
        ["p-2", "gone", "/tmp/a/gone", "2026-08-01T00:00:00.000Z"],
        ["p-3", "worklog", "/tmp/b/worklog", null],
      ],
    );
    NodeAssert.deepEqual(
      projects.map((p) => p.baseDir),
      [alpha.baseDir, alpha.baseDir, beta.baseDir],
    );
  });

  NodeTest.it("returns nothing for no handles", () => {
    NodeAssert.deepEqual(readProjects([]), []);
    NodeAssert.deepEqual(readProjects(undefined), []);
  });
});

NodeTest.describe("readThreads", () => {
  const alpha = makeBaseDir("threads-alpha");

  insertThread(alpha.db, {
    threadId: "in-window",
    title: "Sync fork with upstream",
    branch: "t3x/sync",
    worktreePath: "/tmp/wt",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T18:00:00.000Z",
    modelSelectionJson: JSON.stringify({ instanceId: "claudeAgent", model: "claude-opus-4-8" }),
    latestUserMessageAt: "2026-08-10T17:00:00.000Z",
  });
  // Started long ago, still being updated inside the window.
  insertThread(alpha.db, {
    threadId: "long-running",
    createdAt: "2026-03-20T18:35:07.854Z",
    updatedAt: "2026-08-10T05:00:00.000Z",
    modelSelectionJson: "{not json at all",
  });
  // updated_at exactly on the lower bound: inclusive.
  insertThread(alpha.db, {
    threadId: "edge-start",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: DAY_START,
    modelSelectionJson: JSON.stringify({ instanceId: "claudeAgent" }),
  });
  // created_at exactly on the upper bound: exclusive.
  insertThread(alpha.db, {
    threadId: "edge-end",
    createdAt: DAY_END,
    updatedAt: "2026-08-11T09:00:00.000Z",
  });
  // Finished a millisecond before the window opened.
  insertThread(alpha.db, {
    threadId: "before-window",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-10T03:59:59.999Z",
  });
  insertThread(alpha.db, {
    threadId: "archived-and-deleted",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    archivedAt: "2026-08-10T09:30:00.000Z",
    deletedAt: "2026-08-10T09:40:00.000Z",
  });
  alpha.db.close();

  const beta = makeBaseDir("threads-beta");
  insertThread(beta.db, {
    threadId: "other-base",
    createdAt: "2026-08-10T11:00:00.000Z",
    updatedAt: "2026-08-10T11:30:00.000Z",
  });
  beta.db.close();

  const { handles } = open([alpha.baseDir, beta.baseDir]);

  NodeTest.it("includes only threads whose activity window overlaps the range", () => {
    const ids = readThreads(handles, WINDOW).map((t) => t.threadId);
    NodeAssert.deepEqual(ids.slice().sort(), [
      "archived-and-deleted",
      "edge-start",
      "in-window",
      "long-running",
      "other-base",
    ]);
  });

  NodeTest.it("maps every field and merges base dirs", () => {
    const threads = readThreads(handles, WINDOW);
    const found = threads.find((t) => t.threadId === "in-window");
    NodeAssert.deepEqual(found, {
      baseDir: alpha.baseDir,
      threadId: "in-window",
      projectId: "proj-1",
      title: "Sync fork with upstream",
      branch: "t3x/sync",
      worktreePath: "/tmp/wt",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T18:00:00.000Z",
      deletedAt: null,
      archivedAt: null,
      models: ["claude-opus-4-8"],
      latestUserMessageAt: "2026-08-10T17:00:00.000Z",
    });
    NodeAssert.equal(threads.find((t) => t.threadId === "other-base").baseDir, beta.baseDir);
  });

  NodeTest.it("keeps deleted and archived timestamps rather than filtering them out", () => {
    const found = readThreads(handles, WINDOW).find((t) => t.threadId === "archived-and-deleted");
    NodeAssert.equal(found.archivedAt, "2026-08-10T09:30:00.000Z");
    NodeAssert.equal(found.deletedAt, "2026-08-10T09:40:00.000Z");
  });

  NodeTest.it("tolerates malformed, absent, and model-less model_selection_json", () => {
    const byId = new Map(readThreads(handles, WINDOW).map((t) => [t.threadId, t.models]));
    NodeAssert.deepEqual(byId.get("long-running"), []);
    NodeAssert.deepEqual(byId.get("edge-start"), []);
    NodeAssert.deepEqual(byId.get("other-base"), []);
  });

  NodeTest.it("treats a missing window as unbounded", () => {
    NodeAssert.equal(readThreads(handles, {}).length, 7);
    NodeAssert.equal(readThreads(handles, undefined).length, 7);
  });
});

NodeTest.describe("readTurns", () => {
  const base = makeBaseDir("turns");
  const NOW = "2026-08-10T20:00:00.000Z";

  insertTurn(base.db, {
    threadId: "t-1",
    turnId: "turn-inside",
    requestedAt: "2026-08-10T10:00:00.000Z",
    startedAt: "2026-08-10T10:00:01.000Z",
    completedAt: "2026-08-10T10:05:00.000Z",
    checkpointFilesJson: JSON.stringify([
      { path: "apps/server/src/coil/a.ts", kind: "modified", additions: 12, deletions: 3 },
      { path: "  ", kind: "modified", additions: 1, deletions: 1 },
      { kind: "added" },
      null,
      "not-an-object",
      { path: "b.ts", additions: "7", deletions: null },
    ]),
  });
  // Still running: no completed_at.
  insertTurn(base.db, {
    threadId: "t-1",
    turnId: "turn-running",
    state: "running",
    requestedAt: "2026-08-10T19:00:00.000Z",
    completedAt: null,
  });
  // Completed exactly when the window opens: inclusive.
  insertTurn(base.db, {
    threadId: "t-1",
    turnId: "turn-edge-start",
    requestedAt: "2026-08-09T23:00:00.000Z",
    completedAt: DAY_START,
  });
  // Requested exactly when the window closes: exclusive.
  insertTurn(base.db, {
    threadId: "t-1",
    turnId: "turn-edge-end",
    requestedAt: DAY_END,
    completedAt: "2026-08-11T05:00:00.000Z",
  });
  insertTurn(base.db, {
    threadId: "t-1",
    turnId: "turn-before",
    requestedAt: "2026-08-09T10:00:00.000Z",
    completedAt: "2026-08-10T03:59:59.999Z",
  });
  insertTurn(base.db, {
    threadId: "t-2",
    turnId: "turn-other-thread",
    requestedAt: "2026-08-10T11:00:00.000Z",
    completedAt: "2026-08-10T11:01:00.000Z",
    checkpointFilesJson: "{ this is not json",
  });
  base.db.close();

  const { handles } = open([base.baseDir]);

  NodeTest.it("selects turns whose run span overlaps the window", () => {
    const ids = readTurns(handles, ["t-1"], { ...WINDOW, now: NOW }).map((t) => t.turnId);
    NodeAssert.deepEqual(ids, ["turn-edge-start", "turn-inside", "turn-running"]);
  });

  NodeTest.it("treats a running turn as still running now", () => {
    const running = readTurns(handles, ["t-1"], { ...WINDOW, now: NOW }).find(
      (t) => t.turnId === "turn-running",
    );
    NodeAssert.equal(running.completedAt, null);
    NodeAssert.equal(running.state, "running");

    // A window that has not opened yet cannot contain a turn that is running now.
    const future = readTurns(handles, ["t-1"], {
      start: "2027-01-01T00:00:00.000Z",
      end: "2027-01-02T00:00:00.000Z",
      now: NOW,
    });
    NodeAssert.deepEqual(future, []);
  });

  NodeTest.it("parses checkpoint files and drops unusable entries", () => {
    const turn = readTurns(handles, ["t-1"], { ...WINDOW, now: NOW }).find(
      (t) => t.turnId === "turn-inside",
    );
    NodeAssert.deepEqual(turn.files, [
      { path: "apps/server/src/coil/a.ts", kind: "modified", additions: 12, deletions: 3 },
      { path: "b.ts", kind: null, additions: 7, deletions: 0 },
    ]);
  });

  NodeTest.it("defaults malformed checkpoint_files_json to an empty list", () => {
    const turn = readTurns(handles, ["t-2"], { ...WINDOW, now: NOW })[0];
    NodeAssert.deepEqual(turn.files, []);
    NodeAssert.equal(turn.threadId, "t-2");
    NodeAssert.equal(turn.baseDir, base.baseDir);
  });

  NodeTest.it("returns nothing for an empty thread list and everything for no list", () => {
    NodeAssert.deepEqual(readTurns(handles, [], { ...WINDOW, now: NOW }), []);
    const all = readTurns(handles, null, { ...WINDOW, now: NOW }).map((t) => t.turnId);
    NodeAssert.deepEqual(all.slice().sort(), [
      "turn-edge-start",
      "turn-inside",
      "turn-other-thread",
      "turn-running",
    ]);
  });

  NodeTest.it("chunks a thread list larger than SQLite's parameter budget", () => {
    const ids = Array.from({ length: 900 }, (_, index) => `filler-${index}`);
    ids.splice(450, 0, "t-1");
    const turns = readTurns(handles, ids, { ...WINDOW, now: NOW });
    NodeAssert.deepEqual(turns.map((t) => t.turnId).sort(), [
      "turn-edge-start",
      "turn-inside",
      "turn-running",
    ]);
  });
});

NodeTest.describe("readActivities", () => {
  // Split so the literal never sits in a source file for a secret scanner to flag.
  const SECRET = ["ghp", "_FAKE0SECRET0VALUE0DO0NOT0LEAK"].join("");
  const LONG_DETAIL = `Bash: ${"x".repeat(600)}`;

  const alpha = makeBaseDir("activities-alpha");
  insertActivity(alpha.db, {
    threadId: "t-1",
    turnId: "turn-1",
    kind: "tool.completed",
    createdAt: "2026-08-10T10:00:00.000Z",
    sequence: 2,
    payloadJson: JSON.stringify({
      itemType: "tool",
      detail: "Bash: git status",
      data: {
        toolName: "Bash",
        input: { command: `export TOKEN=${SECRET}` },
        result: `token is ${SECRET} and here is a whole file dump`,
      },
    }),
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "tool.completed",
    createdAt: "2026-08-10T10:00:01.000Z",
    payloadJson: JSON.stringify({
      itemType: "tool",
      detail: LONG_DETAIL,
      data: { toolName: "Bash" },
    }),
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "task.progress",
    createdAt: "2026-08-10T10:01:00.000Z",
    payloadJson: JSON.stringify({
      taskId: "task-a",
      title: "Rebase the fork onto upstream",
      detail: "Reading SEAMS.md",
      lastToolName: "Read",
      usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 900 },
    }),
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "task.progress",
    createdAt: "2026-08-10T10:02:00.000Z",
    payloadJson: "{ truncated payload, definitely not json",
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "context-window.updated",
    createdAt: "2026-08-10T10:03:00.000Z",
    payloadJson: JSON.stringify({ used: 40000 }),
  });
  insertActivity(alpha.db, {
    threadId: "t-9",
    kind: "tool.completed",
    createdAt: "2026-08-10T10:04:00.000Z",
    payloadJson: JSON.stringify({ detail: "other thread" }),
  });
  // Point events outside the window.
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "tool.completed",
    createdAt: "2026-08-10T03:59:59.999Z",
    payloadJson: JSON.stringify({ detail: "too early" }),
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "tool.completed",
    createdAt: DAY_END,
    payloadJson: JSON.stringify({ detail: "too late" }),
  });
  insertActivity(alpha.db, {
    threadId: "t-1",
    kind: "tool.completed",
    createdAt: DAY_START,
    payloadJson: JSON.stringify({ detail: "exactly at the start" }),
  });
  alpha.db.close();

  const beta = makeBaseDir("activities-beta");
  insertActivity(beta.db, {
    threadId: "t-1",
    kind: "task.progress",
    createdAt: "2026-08-10T10:00:00.500Z",
    payloadJson: JSON.stringify({ taskId: "task-b", title: "From the other base dir" }),
  });
  beta.db.close();

  const { handles } = open([alpha.baseDir, beta.baseDir]);

  NodeTest.it("never returns tool input or result, and never the generic summary column", () => {
    const activities = readActivities(handles, ["t-1"], WINDOW);
    const serialised = JSON.stringify(activities);

    NodeAssert.ok(
      !serialised.includes(SECRET),
      "payload.data.result / .input must never escape t3db",
    );
    NodeAssert.ok(!serialised.includes("whole file dump"));
    NodeAssert.ok(!serialised.includes("export TOKEN"));
    NodeAssert.ok(
      !serialised.includes("GENERIC-SUMMARY-LABEL"),
      "the summary column is a label, not a summary",
    );

    // And nothing sneaks through as an unexpected extra field.
    for (const activity of activities) {
      NodeAssert.deepEqual(Object.keys(activity).sort(), [
        "baseDir",
        "createdAt",
        "detail",
        "kind",
        "sequence",
        "taskId",
        "taskTitle",
        "threadId",
        "tokens",
        "toolName",
        "turnId",
      ]);
    }
  });

  NodeTest.it("extracts detail, toolName, taskId, title, and tokens from the payload", () => {
    const activities = readActivities(handles, ["t-1"], WINDOW);
    const tool = activities.find((a) => a.detail === "Bash: git status");
    NodeAssert.equal(tool.toolName, "Bash");
    NodeAssert.equal(tool.turnId, "turn-1");
    NodeAssert.equal(tool.sequence, 2);
    NodeAssert.equal(tool.taskId, null);
    NodeAssert.equal(tool.tokens, null);

    const task = activities.find((a) => a.taskId === "task-a");
    NodeAssert.equal(task.taskTitle, "Rebase the fork onto upstream");
    NodeAssert.equal(task.detail, "Reading SEAMS.md");
    NodeAssert.equal(task.tokens, 1200);
    NodeAssert.equal(task.toolName, null, "lastToolName is not data.toolName");
  });

  NodeTest.it("truncates detail to 240 characters", () => {
    const long = readActivities(handles, ["t-1"], WINDOW).find(
      (a) => a.detail !== null && a.detail.startsWith("Bash: xxx"),
    );
    NodeAssert.equal(long.detail.length, 240);
    NodeAssert.ok(long.detail.endsWith("…"));
  });

  NodeTest.it("keeps a row whose payload will not parse, with null facts", () => {
    const activities = readActivities(handles, ["t-1"], WINDOW);
    const broken = activities.filter(
      (a) => a.createdAt === "2026-08-10T10:02:00.000Z" && a.kind === "task.progress",
    );
    NodeAssert.equal(broken.length, 1);
    NodeAssert.deepEqual(
      { d: broken[0].detail, t: broken[0].toolName, i: broken[0].taskId, k: broken[0].tokens },
      { d: null, t: null, i: null, k: null },
    );
  });

  NodeTest.it("applies the window with an inclusive start and an exclusive end", () => {
    const details = new Set(readActivities(handles, ["t-1"], WINDOW).map((a) => a.detail));
    NodeAssert.ok(details.has("exactly at the start"));
    NodeAssert.ok(!details.has("too early"));
    NodeAssert.ok(!details.has("too late"));
  });

  NodeTest.it("filters by kind whitelist, and returns nothing for an empty whitelist", () => {
    const tasks = readActivities(handles, ["t-1"], { ...WINDOW, kinds: ["task.progress"] });
    NodeAssert.deepEqual(new Set(tasks.map((a) => a.kind)), new Set(["task.progress"]));
    NodeAssert.equal(tasks.length, 3);
    NodeAssert.deepEqual(readActivities(handles, ["t-1"], { ...WINDOW, kinds: [] }), []);
    NodeAssert.deepEqual(readActivities(handles, [], WINDOW), []);
  });

  NodeTest.it("merges base dirs into one chronological timeline", () => {
    const activities = readActivities(handles, ["t-1"], WINDOW);
    const stamps = activities.map((a) => a.createdAt);
    NodeAssert.deepEqual(stamps, stamps.slice().sort());
    const fromBeta = activities.find((a) => a.taskId === "task-b");
    NodeAssert.equal(fromBeta.baseDir, beta.baseDir);
    NodeAssert.equal(
      activities.indexOf(fromBeta),
      2,
      "the beta row sorts between the two 10:00 alpha rows",
    );
  });
});

NodeTest.describe("tokensByTask", () => {
  NodeTest.it("takes the max per task because usage.total_tokens is cumulative", () => {
    const activities = [
      { taskId: "task-a", tokens: 100 },
      { taskId: "task-a", tokens: 500 },
      { taskId: "task-a", tokens: 1200 },
      { taskId: "task-b", tokens: 50 },
      { taskId: "task-b", tokens: 900 },
    ];
    // A naive sum would report 2750.
    NodeAssert.equal(tokensByTask(activities), 2100);
  });

  NodeTest.it("ignores rows that cannot be attributed or counted", () => {
    NodeAssert.equal(
      tokensByTask([
        { taskId: null, tokens: 999 },
        { taskId: "task-c", tokens: null },
        { taskId: "task-c", tokens: -5 },
        { taskId: "task-d", tokens: 10 },
        null,
        undefined,
      ]),
      10,
    );
    NodeAssert.equal(tokensByTask([]), 0);
    NodeAssert.equal(tokensByTask(undefined), 0);
  });

  NodeTest.it("works end to end against rows read from a database", () => {
    const base = makeBaseDir("tokens");
    const cumulative = [
      ["task-a", 100],
      ["task-a", 640],
      ["task-a", 640],
      ["task-b", 25],
      ["task-b", 4000],
    ];
    cumulative.forEach(([taskId, total], index) => {
      insertActivity(base.db, {
        threadId: "t-1",
        kind: "task.progress",
        createdAt: `2026-08-10T12:0${index}:00.000Z`,
        payloadJson: JSON.stringify({ taskId, title: taskId, usage: { total_tokens: total } }),
      });
    });
    // Newer builds moved the counter to typedUsage.totalTokens.
    insertActivity(base.db, {
      threadId: "t-1",
      kind: "task.progress",
      createdAt: "2026-08-10T12:09:00.000Z",
      payloadJson: JSON.stringify({
        taskId: "task-c",
        title: "typed",
        typedUsage: { totalTokens: 7 },
      }),
    });
    base.db.close();

    const { handles } = open([base.baseDir]);
    const activities = readActivities(handles, ["t-1"], WINDOW);
    NodeAssert.equal(tokensByTask(activities), 640 + 4000 + 7);
  });

  NodeTest.it("counts a workflow once, not once per child task", () => {
    // Real shape, from `~/.t3/userdata/state.sqlite`: a `local_workflow` task `wrv3655vp` whose
    // children are `wrv3655vp:wf:<n>`. The parent's cumulative total was 1,713,516 — exactly the
    // sum of its twelve children, because the parent's counter already includes them.
    const children = [
      115909, 155345, 96261, 114711, 86227, 130003, 164676, 243406, 178415, 158626, 186551, 83386,
    ];
    const parentTotal = children.reduce((sum, tokens) => sum + tokens, 0);
    const activities = [
      { taskId: "wrv3655vp", tokens: 12 },
      { taskId: "wrv3655vp", tokens: parentTotal },
      ...children.map((tokens, index) => ({ taskId: `wrv3655vp:wf:${index + 1}`, tokens })),
    ];

    // Summing parent and children alike would report exactly double.
    NodeAssert.equal(tokensByTask(activities), parentTotal);
  });

  NodeTest.it("still counts a child whose parent is outside the window", () => {
    // A day that catches the tail of a workflow started yesterday has the children but not the
    // parent row; dropping them unconditionally would lose the day's real token spend.
    NodeAssert.equal(
      tokensByTask([
        { taskId: "wrv3655vp:wf:1", tokens: 100 },
        { taskId: "wrv3655vp:wf:2", tokens: 250 },
      ]),
      350,
    );
  });

  NodeTest.it("collapses a three-level nest onto the outermost task", () => {
    NodeAssert.equal(
      tokensByTask([
        { taskId: "abc", tokens: 900 },
        { taskId: "abc:wf:1", tokens: 500 },
        { taskId: "abc:wf:1:wf:2", tokens: 200 },
      ]),
      900,
    );
    // A middle level missing from the window must not orphan the deepest one back into the total.
    NodeAssert.equal(
      tokensByTask([
        { taskId: "abc", tokens: 900 },
        { taskId: "abc:wf:1:wf:2", tokens: 200 },
      ]),
      900,
    );
    // With the outermost absent, the deepest still rolls up to the nearest ancestor present.
    NodeAssert.equal(
      tokensByTask([
        { taskId: "abc:wf:1", tokens: 500 },
        { taskId: "abc:wf:1:wf:2", tokens: 200 },
      ]),
      500,
    );
  });

  NodeTest.it("treats a shared prefix that is not a nesting boundary as two separate tasks", () => {
    // Independent tasks that merely share a prefix.
    NodeAssert.equal(
      tokensByTask([
        { taskId: "abc123", tokens: 30 },
        { taskId: "abc1234", tokens: 4 },
      ]),
      34,
    );
    // And the case that actually occurs: sibling workflow steps, where `:wf:1` is a textual prefix
    // of `:wf:10`. Only the alphanumeric character after the prefix distinguishes them.
    NodeAssert.equal(
      tokensByTask([
        { taskId: "wrv3655vp:wf:1", tokens: 7 },
        { taskId: "wrv3655vp:wf:10", tokens: 11 },
        { taskId: "wrv3655vp:wf:11", tokens: 13 },
      ]),
      31,
    );
  });

  NodeTest.it("rolls nested task rows up end to end from a database", () => {
    const base = makeBaseDir("tokens-nested");
    const rows = [
      ["wq0ltrafo", 900],
      ["wq0ltrafo:wf:1", 400],
      ["wq0ltrafo:wf:2", 500],
      // A separate task whose id shares a prefix with the workflow parent.
      ["wq0ltrafo9", 25],
    ];
    rows.forEach(([taskId, total], index) => {
      insertActivity(base.db, {
        threadId: "t-1",
        kind: "task.progress",
        createdAt: `2026-08-10T13:0${index}:00.000Z`,
        payloadJson: JSON.stringify({ taskId, title: taskId, usage: { total_tokens: total } }),
      });
    });
    base.db.close();

    const { handles } = open([base.baseDir]);
    const activities = readActivities(handles, ["t-1"], WINDOW);
    NodeAssert.equal(tokensByTask(activities), 900 + 25);
  });
});

NodeTest.describe("readThreadMessages", () => {
  const alpha = makeBaseDir("messages-alpha");
  insertMessage(alpha.db, {
    messageId: "m-1",
    threadId: "t-1",
    turnId: "turn-1",
    role: "user",
    text: "First prompt",
    createdAt: "2026-08-10T09:00:00.000Z",
  });
  insertMessage(alpha.db, {
    messageId: "m-2",
    threadId: "t-1",
    role: "assistant",
    text: "First answer",
    createdAt: "2026-08-10T09:01:00.000Z",
  });
  insertMessage(alpha.db, {
    messageId: "m-3",
    threadId: "t-1",
    role: "user",
    text: "Second prompt",
    createdAt: "2026-08-10T09:02:00.000Z",
  });
  insertMessage(alpha.db, {
    messageId: "m-4",
    threadId: "t-2",
    role: "user",
    text: "A different thread",
    createdAt: "2026-08-10T09:03:00.000Z",
  });
  alpha.db.close();

  const beta = makeBaseDir("messages-beta");
  insertMessage(beta.db, {
    messageId: "m-5",
    threadId: "t-1",
    role: "user",
    text: "From the other base dir",
    createdAt: "2026-08-10T09:00:30.000Z",
  });
  beta.db.close();

  const { handles } = open([alpha.baseDir, beta.baseDir]);

  NodeTest.it("returns one thread's messages oldest first, across base dirs", () => {
    const messages = readThreadMessages(handles, "t-1", {});
    NodeAssert.deepEqual(
      messages.map((m) => m.messageId),
      ["m-1", "m-5", "m-2", "m-3"],
    );
    NodeAssert.deepEqual(messages[0], {
      messageId: "m-1",
      threadId: "t-1",
      turnId: "turn-1",
      role: "user",
      text: "First prompt",
      createdAt: "2026-08-10T09:00:00.000Z",
    });
  });

  NodeTest.it("treats afterIso as an exclusive cursor", () => {
    const messages = readThreadMessages(handles, "t-1", { afterIso: "2026-08-10T09:01:00.000Z" });
    NodeAssert.deepEqual(
      messages.map((m) => m.messageId),
      ["m-3"],
    );
  });

  NodeTest.it("filters by role and applies a global limit", () => {
    NodeAssert.deepEqual(
      readThreadMessages(handles, "t-1", { roles: ["user"] }).map((m) => m.messageId),
      ["m-1", "m-5", "m-3"],
    );
    NodeAssert.deepEqual(
      readThreadMessages(handles, "t-1", { limit: 2 }).map((m) => m.messageId),
      ["m-1", "m-5"],
      "the limit must apply to the merged result, not per database",
    );
    NodeAssert.deepEqual(readThreadMessages(handles, "t-1", { roles: [] }), []);
  });

  NodeTest.it("returns nothing for an unknown or missing thread id", () => {
    NodeAssert.deepEqual(readThreadMessages(handles, "nope", {}), []);
    NodeAssert.deepEqual(readThreadMessages(handles, "", {}), []);
    NodeAssert.deepEqual(readThreadMessages(handles, undefined, {}), []);
  });
});

NodeTest.describe("firstUserPromptsByThread", () => {
  const base = makeBaseDir("first-prompts");
  insertMessage(base.db, {
    threadId: "t-1",
    role: "assistant",
    text: "assistant speaks first in this fixture",
    createdAt: "2026-08-10T07:59:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-1",
    role: "user",
    text: "Earliest in window",
    createdAt: "2026-08-10T08:00:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-1",
    role: "user",
    text: "Later in window",
    createdAt: "2026-08-10T08:30:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-2",
    role: "user",
    text: "Yesterday, before the window",
    createdAt: "2026-08-09T20:00:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-2",
    role: "user",
    text: "Today, first inside the window",
    createdAt: "2026-08-10T06:00:00.000Z",
  });
  base.db.close();

  const { handles } = open([base.baseDir]);

  NodeTest.it("returns the earliest in-window user message per thread", () => {
    const prompts = firstUserPromptsByThread(handles, WINDOW);
    NodeAssert.ok(prompts instanceof Map);
    NodeAssert.equal(prompts.size, 2);
    NodeAssert.deepEqual(prompts.get("t-1"), {
      text: "Earliest in window",
      createdAt: "2026-08-10T08:00:00.000Z",
    });
    NodeAssert.deepEqual(prompts.get("t-2"), {
      text: "Today, first inside the window",
      createdAt: "2026-08-10T06:00:00.000Z",
    });
  });

  NodeTest.it("ignores assistant messages and messages outside the window", () => {
    const prompts = firstUserPromptsByThread(handles, {
      start: "2026-08-10T08:15:00.000Z",
      end: DAY_END,
    });
    NodeAssert.deepEqual([...prompts.keys()], ["t-1"]);
    NodeAssert.equal(prompts.get("t-1").text, "Later in window");
  });
});

NodeTest.describe("normalizePrompt and promptHash", () => {
  NodeTest.it("trims, collapses whitespace, lowercases, and caps at 400 characters", () => {
    NodeAssert.equal(normalizePrompt("  Sync   the\n\tFork  "), "sync the fork");
    NodeAssert.equal(normalizePrompt("A".repeat(500)).length, 400);
    NodeAssert.equal(normalizePrompt(""), "");
    NodeAssert.equal(normalizePrompt(null), "");
    NodeAssert.equal(normalizePrompt(42), "");
  });

  NodeTest.it("hashes two spellings of the same prompt identically", () => {
    NodeAssert.equal(promptHash("Sync the fork"), promptHash("  sync   THE\n fork "));
    NodeAssert.notEqual(promptHash("Sync the fork"), promptHash("Sync the forks"));
    NodeAssert.match(promptHash("anything"), /^[0-9a-f]{64}$/u);
    // Only the first 400 characters count, so a longer prompt with a shared prefix collides.
    NodeAssert.equal(promptHash("b".repeat(400)), promptHash(`${"b".repeat(400)} tail`));
  });
});

NodeTest.describe("promptHashIndex", () => {
  const base = makeBaseDir("hash-index");
  insertMessage(base.db, {
    threadId: "t-1",
    role: "user",
    text: "Rebase the fork onto upstream",
    createdAt: "2026-08-10T08:00:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-2",
    role: "user",
    text: "  rebase THE fork   onto upstream ",
    createdAt: "2026-08-10T09:00:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-3",
    role: "user",
    text: "   \n  ",
    createdAt: "2026-08-10T09:30:00.000Z",
  });
  insertMessage(base.db, {
    threadId: "t-4",
    role: "assistant",
    text: "Rebase the fork onto upstream",
    createdAt: "2026-08-10T07:00:00.000Z",
  });
  base.db.close();

  const { handles } = open([base.baseDir]);

  NodeTest.it("indexes in-window user prompts by hash, earliest thread winning", () => {
    const index = promptHashIndex(handles, WINDOW);
    const hit = index.get(promptHash("Rebase the fork onto upstream"));
    NodeAssert.deepEqual(hit, { threadId: "t-1", createdAt: "2026-08-10T08:00:00.000Z" });
    NodeAssert.equal(index.size, 1, "blank prompts and assistant messages must not be indexed");
  });

  NodeTest.it("respects the window", () => {
    const index = promptHashIndex(handles, {
      start: "2026-08-10T08:30:00.000Z",
      end: DAY_END,
    });
    NodeAssert.equal(index.get(promptHash("Rebase the fork onto upstream")).threadId, "t-2");
  });
});

NodeTest.describe("degrading instead of throwing", () => {
  NodeTest.it("returns empty results and warnings for a database with no projection tables", () => {
    const baseDir = NodePath.join(tmpRoot, "empty-db");
    NodeFS.mkdirSync(baseDir, { recursive: true });
    const writer = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "state.sqlite"));
    writer.exec("CREATE TABLE unrelated (id TEXT)");
    writer.close();

    const { handles, warnings } = open([baseDir]);
    NodeAssert.equal(handles.length, 1);
    NodeAssert.deepEqual(warnings, []);

    const projects = readProjects(handles);
    NodeAssert.deepEqual(projects, []);
    NodeAssert.equal(projects.warnings.length, 1);
    NodeAssert.match(projects.warnings[0], /projection_projects is missing/u);

    NodeAssert.deepEqual(readThreads(handles, WINDOW), []);
    NodeAssert.deepEqual(readTurns(handles, ["t-1"], WINDOW), []);
    NodeAssert.deepEqual(readActivities(handles, ["t-1"], WINDOW), []);
    NodeAssert.deepEqual(readThreadMessages(handles, "t-1", {}), []);
    NodeAssert.equal(firstUserPromptsByThread(handles, WINDOW).size, 0);
    NodeAssert.equal(promptHashIndex(handles, WINDOW).size, 0);
  });

  NodeTest.it("skips a table that lost a column it cannot work without", () => {
    const baseDir = NodePath.join(tmpRoot, "drifted-db");
    NodeFS.mkdirSync(baseDir, { recursive: true });
    const writer = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "state.sqlite"));
    // `updated_at` has gone away — the overlap filter cannot be expressed any more.
    writer.exec(
      "CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
    );
    writer.exec("INSERT INTO projection_threads VALUES ('t-1', '2026-08-10T10:00:00.000Z')");
    writer.close();

    const { handles } = open([baseDir]);
    const threads = readThreads(handles, WINDOW);
    NodeAssert.deepEqual(threads, []);
    NodeAssert.match(threads.warnings[0], /missing updated_at/u);
  });

  NodeTest.it("tolerates missing and malformed handles everywhere", () => {
    for (const handles of [undefined, null, [], [null], [{}], [{ db: null }], "nope"]) {
      NodeAssert.deepEqual(readProjects(handles), []);
      NodeAssert.deepEqual(readThreads(handles, WINDOW), []);
      NodeAssert.deepEqual(readTurns(handles, null, WINDOW), []);
      NodeAssert.deepEqual(readActivities(handles, null, WINDOW), []);
      NodeAssert.deepEqual(readThreadMessages(handles, "t-1", {}), []);
      NodeAssert.equal(firstUserPromptsByThread(handles, WINDOW).size, 0);
      NodeAssert.equal(promptHashIndex(handles, WINDOW).size, 0);
    }
  });
});

NodeTest.describe("warnings channel", () => {
  NodeTest.it("is non-enumerable so results still behave like plain arrays", () => {
    // The fixture name must not contain "warnings" — it lands in baseDir and would fool the
    // serialisation assertion below.
    const base = makeBaseDir("result-shape");
    insertProject(base.db, { projectId: "p-1", title: "t", workspaceRoot: "/tmp/t" });
    base.db.close();

    const { handles } = open([base.baseDir]);
    const projects = readProjects(handles);

    NodeAssert.ok(Array.isArray(projects.warnings));
    NodeAssert.deepEqual(Object.keys(projects), ["0"]);
    NodeAssert.ok(!JSON.stringify(projects).includes("warnings"));
    NodeAssert.equal([...projects].length, 1);
  });
});
