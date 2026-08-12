// Tests for lib/bundle.mjs and lib/summary.mjs.
//
// Every store is injected: the T3code readers and the Claude Code scanner are fakes, git is a fake
// that records what it was asked for, and the only real filesystem in play is a mkdtemp worklog
// repo. The suite therefore never opens the user's databases, never shells out, and never touches
// ~/.t3 or ~/.claude. Run with: node --test scripts/coil/worklog/test/bundle.test.mjs
//
// The registry and the dedup ladder are deliberately NOT faked — a real config/projects.yaml and
// the real `linkSessions` are what make these assertions mean anything.

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { collect } from "../lib/bundle.mjs";
import { renderStatLine, renderSummary } from "../lib/summary.mjs";
import { promptHash } from "../lib/t3db.mjs";
import { worklogPaths } from "../lib/paths.mjs";

/** An extract file exactly as `worklog extract-commit` writes it (lib/extract.mjs owns the shape). */
function extractDocument(sessionKey, { cursorAt, ...fields }) {
  return JSON.stringify({
    schemaVersion: 1,
    sessionKey,
    updatedAt: cursorAt,
    cursor: { lastEventAt: cursorAt, lastTurnId: null, turnsProcessed: 1 },
    extract: { problem: "", approach: "", outcome: "", artifacts: [], status: "", ...fields },
    history: [],
  });
}

const DAY_A = "2026-08-10";
const DAY_B = "2026-08-11";
// A Monday-evening "now": late enough that every fixture stamp is in the past, so a running turn is
// clipped at a stable point instead of at the wall clock.
const NOW = new Date(2026, 7, 11, 23, 30).getTime();

/** Local-time ISO stamp, so a fixture lands on the intended LOCAL day in any timezone. */
function at(day, hour, minute = 0, second = 0) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, hour, minute, second).toISOString();
}

/** A throwaway worklog repo; `t.after` removes it, so no test writes outside the temp dir. */
function tempRoot(t) {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-")));
  t.after(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeRegistry(root, body) {
  const paths = worklogPaths(root);
  NodeFS.mkdirSync(paths.config, { recursive: true });
  NodeFS.writeFileSync(paths.projectsYaml, body, "utf8");
  NodeFS.writeFileSync(
    paths.redactionYaml,
    ["version: 1", "always_redact:", "  - Client X", "replacements: {}", ""].join("\n"),
    "utf8",
  );
  return paths;
}

/** The standard three-project registry: one public, one private, one switched off. */
function defaultRegistry(root) {
  return [
    "version: 1",
    "identities:",
    "  - Raj D",
    "defaults:",
    "  active_gap_minutes: 30",
    "  single_event_minutes: 1",
    "projects:",
    "  t3code:",
    "    display_name: T3 Code (fork)",
    "    roots:",
    `      - ${root}/dev/t3code`,
    "    include: true",
    "    visibility: public",
    "    confirmed: true",
    "  client-x:",
    "    display_name: Client X",
    "    roots:",
    `      - ${root}/dev/client-x`,
    "    include: true",
    "    visibility: private",
    "    confirmed: true",
    "  retired:",
    "    display_name: Retired Thing",
    "    roots:",
    `      - ${root}/dev/retired`,
    "    include: false",
    "    visibility: public",
    "    confirmed: true",
    "",
  ].join("\n");
}

// --- fixture builders ---------------------------------------------------------------------------

function thread(overrides = {}) {
  return {
    baseDir: "/fake/t3",
    threadId: "thread-1",
    projectId: "project-1",
    title: "Sync fork with upstream",
    branch: "coil/sync",
    worktreePath: null,
    createdAt: at(DAY_A, 9, 0),
    updatedAt: at(DAY_A, 11, 0),
    deletedAt: null,
    archivedAt: null,
    models: ["claude-opus-4-8"],
    latestUserMessageAt: at(DAY_A, 10, 30),
    ...overrides,
  };
}

function turn(overrides = {}) {
  return {
    baseDir: "/fake/t3",
    threadId: "thread-1",
    turnId: "turn-1",
    state: "completed",
    requestedAt: at(DAY_A, 9, 0),
    startedAt: at(DAY_A, 9, 0),
    completedAt: at(DAY_A, 9, 20),
    files: [],
    ...overrides,
  };
}

function activity(overrides = {}) {
  return {
    baseDir: "/fake/t3",
    threadId: "thread-1",
    turnId: "turn-1",
    kind: "tool.completed",
    createdAt: at(DAY_A, 9, 5),
    sequence: 1,
    detail: "Bash: pnpm test",
    toolName: "Bash",
    taskId: null,
    taskTitle: null,
    tokens: null,
    ...overrides,
  };
}

function ccSession(overrides = {}) {
  const eventTimes = overrides.eventTimes ?? [at(DAY_A, 14, 0), at(DAY_A, 14, 30)];
  return {
    sessionId: "cc-session-1",
    file: "/fake/claude/projects/-x/cc-session-1.jsonl",
    cwd: "/fake/cwd",
    gitBranch: "main",
    versions: ["2.1.0"],
    models: ["claude-sonnet-4-6"],
    startedAt: eventTimes[0],
    endedAt: eventTimes[eventTimes.length - 1],
    promptCount: 2,
    assistantCount: 4,
    toolUseCount: 3,
    firstPrompt: "Fix the flaky auth test",
    lastPrompt: "Ship it",
    promptHashes: [promptHash("Fix the flaky auth test")],
    prLinks: [],
    sidechainOnly: false,
    excluded: null,
    ...overrides,
    eventTimes,
  };
}

function commit(overrides = {}) {
  return {
    sha: "714b866bd0000000000000000000000000000000",
    shortSha: "714b866",
    at: at(DAY_A, 12, 0),
    author: "Raj D",
    authorEmail: "raj@example.com",
    subject: "docs(t3x): record the capture",
    files: 2,
    insertions: 40,
    deletions: 5,
    branches: ["main"],
    ...overrides,
  };
}

// --- dependency fakes ---------------------------------------------------------------------------

function fakeT3Db({
  projects = [],
  threads = [],
  turns = [],
  activities = [],
  promptHashes = new Map(),
  overrides = {},
} = {}) {
  return {
    openT3Databases: () => ({
      handles: [{ baseDir: "/fake/t3", dbPath: "/fake/t3/state.sqlite", db: {} }],
      warnings: [],
    }),
    closeDatabases: () => {},
    readProjects: () => projects,
    readThreads: () => threads,
    readTurns: () => turns,
    readActivities: () => activities,
    promptHashIndex: () => promptHashes,
    ...overrides,
  };
}

function fakeClaudeCode(sessions, overrides = {}) {
  return {
    // Real `linkSessions` is left in place by the merge, so the §6 ladder is genuinely exercised.
    scanSessions: async () => ({
      sessions: sessions.map((session) => ({ ...session })),
      warnings: [],
    }),
    ...overrides,
  };
}

function fakeGit({ repos = [], canonical = {}, calls = [] } = {}) {
  return {
    calls,
    module: {
      canonicalRepo: (dir) => {
        calls.push(`canonicalRepo:${dir}`);
        return canonical[dir] ?? null;
      },
      collectGit: (dirs) => {
        calls.push(`collectGit:${[...dirs].sort().join(",")}`);
        return { repos: repos.map((repo) => ({ ...repo })), warnings: [] };
      },
      commitsInWindow: () => {
        calls.push("commitsInWindow");
        return [];
      },
      mergedPrs: () => {
        calls.push("mergedPrs");
        return { prs: [], warnings: [] };
      },
      remoteNameWithOwner: () => {
        calls.push("remoteNameWithOwner");
        return null;
      },
    },
  };
}

/** A runner that fails the test if anything tries to shell out. */
function forbiddenRunner() {
  return () => {
    throw new Error("the collector must not shell out in tests");
  };
}

function baseDeps(root, { t3db, claudeCode, git, includeGitRepos } = {}) {
  const paths = {
    worklogPaths: () => worklogPaths(root),
    t3BaseDirs: () => ["/fake/t3"],
    claudeProjectsDir: () => "/fake/claude/projects",
    t3WorktreesRoot: () => `${root}/worktrees`,
  };
  return {
    paths,
    t3db: t3db ?? fakeT3Db(),
    claudeCode: claudeCode ?? fakeClaudeCode([]),
    git: git ?? fakeGit({ repos: includeGitRepos ?? [] }).module,
    run: forbiddenRunner(),
  };
}

/** The everyday fixture: one T3code thread, one standalone session, one repo with a commit. */
async function collectFixture(t, options = {}) {
  const root = options.root ?? tempRoot(t);
  writeRegistry(root, options.registry ?? defaultRegistry(root));

  const gitFake = fakeGit({
    repos: options.repos ?? [
      {
        key: `${root}/dev/t3code/.git`,
        root: `${root}/dev/t3code`,
        nameWithOwner: "radroid/t3code",
        commits: [commit()],
        mergedPrs: [
          {
            number: 66,
            title: "fix(t3x): retry the relay notify",
            url: "https://github.com/radroid/t3code/pull/66",
            mergedAt: at(DAY_A, 13, 0),
            additions: 120,
            deletions: 14,
            author: "radroid",
            headRefName: "t3x/relay",
          },
        ],
        warnings: [],
      },
    ],
    canonical: options.canonical ?? {},
  });

  const bundle = await collect({
    from: options.from ?? DAY_A,
    to: options.to ?? DAY_A,
    worklogRoot: root,
    includeGit: options.includeGit ?? true,
    now: NOW,
    deps: {
      ...baseDeps(root, {
        t3db:
          options.t3db ??
          fakeT3Db({
            projects: [
              {
                baseDir: "/fake/t3",
                projectId: "project-1",
                title: "t3code",
                workspaceRoot: `${root}/dev/t3code`,
                deletedAt: null,
              },
            ],
            threads: [thread()],
            turns: [
              turn(),
              turn({
                turnId: "turn-2",
                requestedAt: at(DAY_A, 10, 0),
                startedAt: at(DAY_A, 10, 0),
                completedAt: at(DAY_A, 10, 40),
                files: [
                  {
                    path: "apps/server/src/coil/relay.ts",
                    kind: "modified",
                    additions: 30,
                    deletions: 4,
                  },
                ],
              }),
            ],
            activities: [
              activity(),
              activity({
                sequence: 2,
                createdAt: at(DAY_A, 10, 5),
                kind: "task.progress",
                taskId: "task-1",
                taskTitle: "Rebase onto upstream",
                tokens: 1000,
              }),
              activity({
                sequence: 3,
                createdAt: at(DAY_A, 10, 20),
                kind: "task.progress",
                taskId: "task-1",
                taskTitle: "Rebase onto upstream",
                tokens: 2500,
              }),
            ],
          }),
        claudeCode:
          options.claudeCode ?? fakeClaudeCode([ccSession({ cwd: `${root}/dev/client-x` })]),
      }),
      git: gitFake.module,
    },
  });

  return { bundle, root, gitCalls: gitFake.calls };
}

// --- shape --------------------------------------------------------------------------------------

NodeTest.test("the bundle carries every field §7 promises", async (t) => {
  const { bundle } = await collectFixture(t);

  NodeAssert.deepEqual(Object.keys(bundle).sort(), [
    "byDay",
    "config",
    "generatedAt",
    "git",
    "projects",
    "range",
    "schemaVersion",
    "sessions",
    "stats",
    "unclassified",
    "warnings",
  ]);
  NodeAssert.equal(bundle.schemaVersion, 1);
  NodeAssert.equal(bundle.generatedAt, new Date(NOW).toISOString());
  NodeAssert.deepEqual(bundle.range.days, [DAY_A]);
  NodeAssert.equal(bundle.range.from, DAY_A);
  NodeAssert.equal(bundle.range.to, DAY_A);
  NodeAssert.equal(typeof bundle.range.timezone, "string");
  NodeAssert.equal(bundle.config.activeGapMinutes, 30);
  NodeAssert.deepEqual(bundle.config.t3BaseDirs, ["/fake/t3"]);
  NodeAssert.equal(bundle.config.claudeProjectsDir, "/fake/claude/projects");

  const project = bundle.projects.find((entry) => entry.key === "t3code");
  NodeAssert.deepEqual(Object.keys(project).sort(), [
    "classification",
    "displayName",
    "key",
    "roots",
    "stats",
  ]);
  NodeAssert.equal(project.displayName, "T3 Code (fork)");
  NodeAssert.equal(project.classification.effective, "public");
  NodeAssert.equal(project.classification.confirmed, true);

  const session = bundle.sessions.find((entry) => entry.key === "t3-thread-1");
  NodeAssert.deepEqual(
    Object.keys(session).sort(),
    [
      "activeMs",
      "agentRuntimeMs",
      "awaitingInputMs",
      "branch",
      "excluded",
      "extract",
      "files",
      "filesApproximate",
      "firstPrompt",
      "key",
      "kind",
      "lastPrompt",
      "materiality",
      "models",
      "needsExtraction",
      "projectKey",
      "signals",
      "startedAt",
      "tokens",
      "title",
      "turnCount",
      "withheldExtract",
      "endedAt",
    ].sort(),
  );
  NodeAssert.equal(session.kind, "t3code");
  NodeAssert.equal(session.projectKey, "t3code");
  NodeAssert.equal(session.title, "Sync fork with upstream");
  NodeAssert.equal(session.turnCount, 2);
  NodeAssert.deepEqual(session.models, ["claude-opus-4-8"]);
  NodeAssert.deepEqual(session.files, [
    { path: "apps/server/src/coil/relay.ts", additions: 30, deletions: 4 },
  ]);
  // usage.total_tokens is cumulative per task, so two rows of one task are 2500, not 3500.
  NodeAssert.equal(session.tokens, 2500);
  NodeAssert.equal(session.extract, null);

  NodeAssert.deepEqual(Object.keys(bundle.stats).sort(), [
    "activeBlocks",
    "activeMs",
    "agentRuntimeMs",
    "awaitingInputMs",
    "commits",
    "filesTouched",
    "filesTouchedApproximate",
    "linesAdded",
    "linesRemoved",
    "projectsTouched",
    "prsMerged",
    "sessions",
    "tokens",
    "turns",
  ]);
  NodeAssert.equal(bundle.stats.sessions, 2);
  NodeAssert.equal(bundle.stats.commits, 1);
  NodeAssert.equal(bundle.stats.prsMerged, 1);
  NodeAssert.equal(bundle.stats.linesAdded, 40);
  NodeAssert.equal(bundle.stats.linesRemoved, 5);
  NodeAssert.equal(bundle.stats.filesTouched, 1);
  NodeAssert.equal(bundle.stats.projectsTouched, 2);
  NodeAssert.ok(bundle.stats.activeBlocks.length >= 1);
  for (const block of bundle.stats.activeBlocks) {
    NodeAssert.deepEqual(Object.keys(block).sort(), ["end", "ms", "start"]);
  }

  const repo = bundle.git.repos[0];
  const day = bundle.byDay[DAY_A];
  NodeAssert.deepEqual(day.sessionKeys.sort(), ["cc-cc-session-1", "t3-thread-1"]);
  NodeAssert.deepEqual(day.repoKeys, [repo.key]);
  NodeAssert.equal(day.commits, 1);

  NodeAssert.equal(repo.nameWithOwner, "radroid/t3code");
  NodeAssert.equal(repo.projectKey, "t3code");
  NodeAssert.equal(repo.commits.length, 1);
});

NodeTest.test(
  "a standalone Claude Code session carries the prompts that are its only prose",
  async (t) => {
    const root = tempRoot(t);
    const long = `Investigate the flaky auth test. ${"more detail ".repeat(400)}`;
    const { bundle } = await collectFixture(t, {
      root,
      claudeCode: fakeClaudeCode([
        ccSession({
          sessionId: "prose",
          cwd: `${root}/dev/client-x`,
          firstPrompt: long,
          lastPrompt: "Ship it",
        }),
      ]),
    });

    // lib/extract.mjs's default slice loader builds a Claude Code slice out of exactly these two
    // fields — there are no `summary` records in this user's history — so dropping them left every
    // terminal-only day reaching the model with no prose at all.
    const session = bundle.sessions.find((entry) => entry.key === "cc-prose");
    NodeAssert.ok(session.firstPrompt.startsWith("Investigate the flaky auth test."));
    NodeAssert.equal(session.lastPrompt, "Ship it");
    // Carried whole, but never unbounded: the bundle is the model's budget.
    NodeAssert.equal(session.firstPrompt.length, 2000);
    NodeAssert.ok(session.firstPrompt.endsWith("…"));

    // A T3code thread's prose lives in projection_thread_messages, which lib/extract.mjs reads from
    // the database itself; the field is present and null rather than absent, so there is one shape.
    const thread1 = bundle.sessions.find((entry) => entry.key === "t3-thread-1");
    NodeAssert.equal(thread1.firstPrompt, null);
    NodeAssert.equal(thread1.lastPrompt, null);
  },
);

NodeTest.test(
  "checkpoint file lists travel flagged, because a snapshot diff is not a census",
  async (t) => {
    const { bundle } = await collectFixture(t);

    // Upstream derives a turn's files by diffing workspace snapshots (CheckpointReactor.ts), so a
    // `git pull` or a rebase landing between turns is in there too. It cannot be corrected from the
    // stored payload — only declared, so the summary and the docs stop reading it as a census.
    const thread1 = bundle.sessions.find((entry) => entry.key === "t3-thread-1");
    NodeAssert.equal(thread1.filesApproximate, true);
    NodeAssert.ok(thread1.files.length > 0);
    const cc = bundle.sessions.find((entry) => entry.key === "cc-cc-session-1");
    NodeAssert.equal(cc.filesApproximate, false);
    NodeAssert.ok(bundle.stats.filesTouched > 0);
    NodeAssert.equal(bundle.stats.filesTouchedApproximate, true);

    // Nothing contributed checkpoint files, so nothing is qualified.
    const { bundle: quiet } = await collectFixture(t, {
      t3db: fakeT3Db(),
      claudeCode: fakeClaudeCode([]),
      repos: [],
    });
    NodeAssert.equal(quiet.stats.filesTouched, 0);
    NodeAssert.equal(quiet.stats.filesTouchedApproximate, false);
  },
);

NodeTest.test(
  "a private project keeps its work in the totals but travels with its classification",
  async (t) => {
    const { bundle } = await collectFixture(t);
    const clientX = bundle.projects.find((entry) => entry.key === "client-x");
    NodeAssert.equal(clientX.classification.effective, "private");
    NodeAssert.equal(clientX.classification.counted, true);
    NodeAssert.equal(clientX.stats.sessions, 1);
    // The stats add up only because the private project's session is still counted.
    NodeAssert.equal(bundle.stats.sessions, 2);
  },
);

// --- time ---------------------------------------------------------------------------------------

NodeTest.test("parallel sessions do not double-count active time", async (t) => {
  const root = tempRoot(t);
  const overlapping = [
    ccSession({
      sessionId: "a",
      cwd: `${root}/dev/client-x`,
      eventTimes: [at(DAY_A, 10, 0), at(DAY_A, 10, 30), at(DAY_A, 11, 0)],
    }),
    ccSession({
      sessionId: "b",
      cwd: `${root}/dev/client-x`,
      promptHashes: [promptHash("something else entirely")],
      eventTimes: [at(DAY_A, 10, 15), at(DAY_A, 10, 45), at(DAY_A, 11, 0)],
    }),
  ];

  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode(overlapping),
    repos: [],
  });

  const hour = 60 * 60 * 1000;
  const [first, second] = ["cc-a", "cc-b"].map((key) => bundle.sessions.find((s) => s.key === key));
  NodeAssert.equal(first.activeMs, hour);
  NodeAssert.equal(second.activeMs, 45 * 60 * 1000);
  // Summed naively that is 1h45m; the merged timeline is the union, so it is exactly one hour.
  NodeAssert.equal(bundle.stats.activeMs, hour);
  NodeAssert.equal(bundle.stats.activeBlocks.length, 1);
  NodeAssert.equal(bundle.projects.find((entry) => entry.key === "client-x").stats.activeMs, hour);
  NodeAssert.ok(renderSummary(bundle).includes("## Active blocks — 1h across 1 block"));
});

NodeTest.test(
  "agent runtime counts overlap twice, and a running turn is clipped at `now`",
  async (t) => {
    const root = tempRoot(t);
    const { bundle } = await collectFixture(t, {
      root,
      from: DAY_A,
      to: DAY_A,
      t3db: fakeT3Db({
        projects: [
          {
            baseDir: "/fake/t3",
            projectId: "project-1",
            title: "t3code",
            workspaceRoot: `${root}/dev/t3code`,
            deletedAt: null,
          },
        ],
        threads: [thread()],
        turns: [
          turn({ turnId: "t1", startedAt: at(DAY_A, 9, 0), completedAt: at(DAY_A, 10, 0) }),
          turn({ turnId: "t2", startedAt: at(DAY_A, 9, 30), completedAt: at(DAY_A, 10, 30) }),
          // Still running: closed at min(window end, now), i.e. the end of the day.
          turn({
            turnId: "t3",
            requestedAt: at(DAY_A, 23, 0),
            startedAt: at(DAY_A, 23, 0),
            completedAt: null,
          }),
        ],
        activities: [],
      }),
      claudeCode: fakeClaudeCode([]),
      repos: [],
    });

    const minutes = (ms) => Math.round(ms / 60000);
    NodeAssert.equal(minutes(bundle.stats.agentRuntimeMs), 60 + 60 + 60);
    NodeAssert.ok(bundle.stats.activeMs < bundle.stats.agentRuntimeMs);
    NodeAssert.equal(bundle.stats.awaitingInputMs, 0);
  },
);

/** One T3code thread whose turns and activities are exactly what the test hands it. */
function threadOnly(root, { turns, activities }) {
  return {
    root,
    t3db: fakeT3Db({
      projects: [
        {
          baseDir: "/fake/t3",
          projectId: "project-1",
          title: "t3code",
          workspaceRoot: `${root}/dev/t3code`,
          deletedAt: null,
        },
      ],
      threads: [thread({ createdAt: at(DAY_A, 0, 1), updatedAt: at(DAY_B, 23, 59) })],
      turns,
      activities,
    }),
    claudeCode: fakeClaudeCode([]),
    repos: [],
  };
}

NodeTest.test("a turn blocked on the human is not billed as agent runtime", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(
    t,
    threadOnly(root, {
      turns: [
        // Three hours of wall clock, ninety minutes of it parked at a question.
        turn({
          turnId: "asked",
          requestedAt: at(DAY_A, 9, 0),
          startedAt: at(DAY_A, 9, 0),
          completedAt: at(DAY_A, 12, 0),
        }),
        // A question that was never answered: the turn sat there until it ended.
        turn({
          turnId: "unanswered",
          requestedAt: at(DAY_A, 13, 0),
          startedAt: at(DAY_A, 13, 0),
          completedAt: at(DAY_A, 15, 0),
        }),
      ],
      activities: [
        activity({ turnId: "asked", kind: "user-input.requested", createdAt: at(DAY_A, 10, 0) }),
        activity({ turnId: "asked", kind: "user-input.resolved", createdAt: at(DAY_A, 11, 30) }),
        activity({
          turnId: "unanswered",
          kind: "user-input.requested",
          createdAt: at(DAY_A, 14, 0),
        }),
      ],
    }),
  );

  const hours = (ms) => ms / 3_600_000;
  const session = bundle.sessions.find((entry) => entry.key === "t3-thread-1");
  // 5h of turn wall clock; 2.5h of it was the human, not the machine.
  NodeAssert.equal(hours(session.agentRuntimeMs), 2.5);
  NodeAssert.equal(hours(session.awaitingInputMs), 2.5);
  NodeAssert.equal(hours(bundle.stats.agentRuntimeMs), 2.5);
  // The correction is published, not just applied — the reader can add it back.
  NodeAssert.equal(hours(bundle.stats.awaitingInputMs), 2.5);
  NodeAssert.equal(
    hours(bundle.projects.find((p) => p.key === "t3code").stats.awaitingInputMs),
    2.5,
  );
  NodeAssert.equal(hours(bundle.byDay[DAY_A].awaitingInputMs), 2.5);
});

NodeTest.test("a wait is clipped and split like any other interval", async (t) => {
  const root = tempRoot(t);
  const spanningTurn = turn({
    turnId: "midnight",
    requestedAt: at(DAY_A, 23, 0),
    startedAt: at(DAY_A, 23, 0),
    completedAt: at(DAY_B, 2, 0),
  });

  const { bundle: range } = await collectFixture(t, {
    ...threadOnly(root, {
      turns: [spanningTurn],
      activities: [
        activity({
          turnId: "midnight",
          kind: "user-input.requested",
          createdAt: at(DAY_A, 23, 20),
        }),
        activity({ turnId: "midnight", kind: "user-input.resolved", createdAt: at(DAY_B, 0, 30) }),
      ],
    }),
    from: DAY_A,
    to: DAY_B,
  });

  const minutes = (ms) => Math.round(ms / 60000);
  NodeAssert.equal(minutes(range.stats.awaitingInputMs), 70);
  NodeAssert.equal(minutes(range.stats.agentRuntimeMs), 180 - 70);
  for (const field of ["agentRuntimeMs", "awaitingInputMs"]) {
    const summed = Object.values(range.byDay).reduce((total, day) => total + day[field], 0);
    NodeAssert.equal(summed, range.stats[field], `byDay.${field} must sum to stats.${field}`);
  }
  NodeAssert.equal(minutes(range.byDay[DAY_A].awaitingInputMs), 40);
  NodeAssert.equal(minutes(range.byDay[DAY_B].awaitingInputMs), 30);

  // Collected for DAY_B alone, the window query never returns the `requested` row — it is on the
  // far side of midnight. The lone resolve still proves the turn was blocked when the day opened.
  const { bundle: dayOnly } = await collectFixture(t, {
    ...threadOnly(root, {
      turns: [spanningTurn],
      activities: [
        activity({ turnId: "midnight", kind: "user-input.resolved", createdAt: at(DAY_B, 0, 30) }),
      ],
    }),
    from: DAY_B,
    to: DAY_B,
  });
  NodeAssert.equal(minutes(dayOnly.stats.awaitingInputMs), 30);
  NodeAssert.equal(minutes(dayOnly.stats.agentRuntimeMs), 120 - 30);
});

NodeTest.test(
  "a turn still waiting on an unanswered question stops billing at the question",
  async (t) => {
    const root = tempRoot(t);
    const { bundle } = await collectFixture(t, {
      ...threadOnly(root, {
        turns: [
          turn({
            turnId: "waiting",
            requestedAt: at(DAY_B, 20, 0),
            startedAt: at(DAY_B, 20, 0),
            completedAt: null,
          }),
        ],
        activities: [
          activity({
            turnId: "waiting",
            kind: "user-input.requested",
            createdAt: at(DAY_B, 21, 0),
          }),
        ],
      }),
      from: DAY_B,
      to: DAY_B,
    });

    const minutes = (ms) => Math.round(ms / 60000);
    // NOW is DAY_B 23:30, so a running turn closes there rather than at the window edge — and the
    // hours since the question went unanswered are the human's, not the machine's.
    NodeAssert.equal(minutes(bundle.stats.agentRuntimeMs), 60);
    NodeAssert.equal(minutes(bundle.stats.awaitingInputMs), 150);
  },
);

// --- dedup --------------------------------------------------------------------------------------

NodeTest.test(
  "a t3code-driven session is excluded from the counts but kept as auditable evidence",
  async (t) => {
    const root = tempRoot(t);
    const driven = ccSession({
      sessionId: "driven",
      cwd: `${root}/worktrees/t3code/abc123`,
      eventTimes: [at(DAY_A, 15, 0), at(DAY_A, 15, 30)],
    });
    const standalone = ccSession({
      sessionId: "standalone",
      cwd: `${root}/dev/client-x`,
      promptHashes: [promptHash("unrelated work")],
      eventTimes: [at(DAY_A, 16, 0), at(DAY_A, 16, 20)],
    });

    const { bundle } = await collectFixture(t, {
      root,
      t3db: fakeT3Db(),
      claudeCode: fakeClaudeCode([driven, standalone]),
      repos: [],
    });

    const excluded = bundle.sessions.find((session) => session.key === "cc-driven");
    NodeAssert.equal(excluded.excluded.reason, "t3code-driven");
    NodeAssert.equal(excluded.excluded.rule, "worktree");
    NodeAssert.equal(excluded.needsExtraction, false);
    NodeAssert.equal(bundle.stats.sessions, 1);
    NodeAssert.equal(bundle.byDay[DAY_A].sessionKeys.includes("cc-driven"), false);
    // Its half hour is not in the merged timeline either, or the day would be inflated twice over.
    NodeAssert.equal(bundle.stats.activeMs, 20 * 60 * 1000);
  },
);

NodeTest.test("the prompt-hash rung links a session that never ran in a worktree", async (t) => {
  const root = tempRoot(t);
  const prompt = "Rebase the fork onto upstream v0.0.33";
  const linked = ccSession({
    sessionId: "hashed",
    cwd: `${root}/dev/t3code`,
    firstPrompt: prompt,
    promptHashes: [promptHash(prompt)],
    eventTimes: [at(DAY_A, 17, 0), at(DAY_A, 17, 30)],
  });

  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db({
      promptHashes: new Map([
        [promptHash(prompt), { threadId: "thread-9", createdAt: at(DAY_A, 16, 59) }],
      ]),
    }),
    claudeCode: fakeClaudeCode([linked]),
    repos: [],
  });

  const session = bundle.sessions.find((entry) => entry.key === "cc-hashed");
  NodeAssert.deepEqual(session.excluded, {
    reason: "t3code-driven",
    rule: "prompt-hash",
    linkedTo: "thread-9",
  });
  NodeAssert.equal(bundle.stats.sessions, 0);
});

// --- classification -----------------------------------------------------------------------------

NodeTest.test("an unregistered project is flagged as unclassified and still counted", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "scratch",
        cwd: `${root}/dev/scratchpad`,
        eventTimes: [at(DAY_A, 18, 0), at(DAY_A, 18, 30)],
      }),
    ]),
    repos: [],
  });

  NodeAssert.equal(bundle.unclassified.length, 1);
  const [entry] = bundle.unclassified;
  NodeAssert.equal(entry.key, "scratchpad");
  NodeAssert.deepEqual(entry.roots, [`${root}/dev/scratchpad`]);
  NodeAssert.equal(entry.evidence.sessions, 1);

  const project = bundle.projects.find((item) => item.key === "scratchpad");
  NodeAssert.equal(project.classification.known, false);
  NodeAssert.equal(project.classification.effective, "excluded");
  NodeAssert.equal(project.classification.counted, true);
  NodeAssert.equal(project.stats.sessions, 1);
  // Unreviewed work still shows up in the totals, or the day would silently under-report.
  NodeAssert.equal(bundle.stats.sessions, 1);
  NodeAssert.equal(bundle.stats.activeMs, 30 * 60 * 1000);
});

NodeTest.test("a worktree resolves to the same project as its main checkout", async (t) => {
  const root = tempRoot(t);
  const worktree = `${root}/checkouts/t3code-abc`;
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "wt",
        cwd: worktree,
        eventTimes: [at(DAY_A, 19, 0), at(DAY_A, 19, 30)],
      }),
    ]),
    // A linked worktree's common dir IS the main checkout's .git.
    canonical: {
      [worktree]: {
        root: worktree,
        commonDir: `${root}/dev/t3code/.git`,
        key: `${root}/dev/t3code/.git`,
      },
    },
    repos: [],
  });

  NodeAssert.equal(bundle.sessions.find((session) => session.key === "cc-wt").projectKey, "t3code");
  NodeAssert.deepEqual(bundle.unclassified, []);
});

NodeTest.test("a project switched off with include:false stays out of the totals", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "off",
        cwd: `${root}/dev/retired`,
        eventTimes: [at(DAY_A, 20, 0), at(DAY_A, 20, 30)],
      }),
    ]),
    repos: [],
  });

  const session = bundle.sessions.find((entry) => entry.key === "cc-off");
  NodeAssert.equal(session.projectKey, "retired");
  NodeAssert.equal(bundle.stats.sessions, 0);
  NodeAssert.equal(bundle.stats.activeMs, 0);
  // The session still resolves to a project the reader can look up.
  const project = bundle.projects.find((entry) => entry.key === "retired");
  NodeAssert.equal(project.classification.counted, false);
  NodeAssert.equal(project.stats.sessions, 0);
});

NodeTest.test("a session whose project cannot be resolved is still counted", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    // A transcript whose records never carried a cwd: there is nowhere to attribute it, but the
    // half hour was still worked, so dropping it would understate the day.
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "nowhere",
        cwd: null,
        eventTimes: [at(DAY_A, 21, 0), at(DAY_A, 21, 30)],
      }),
    ]),
    repos: [],
  });

  const session = bundle.sessions.find((entry) => entry.key === "cc-nowhere");
  NodeAssert.equal(session.projectKey, null);
  NodeAssert.equal(bundle.stats.sessions, 1);
  NodeAssert.equal(bundle.stats.activeMs, 30 * 60 * 1000);
  NodeAssert.deepEqual(bundle.byDay[DAY_A].sessionKeys, ["cc-nowhere"]);
  NodeAssert.equal(bundle.stats.projectsTouched, 0);
  // The summary must still show it, or the model sees a session count it cannot reconcile.
  NodeAssert.ok(renderSummary(bundle).includes("## Sessions outside the project list (1)"));
});

// --- ranges -------------------------------------------------------------------------------------

NodeTest.test("byDay sums back to the range totals across two days", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    from: DAY_A,
    to: DAY_B,
    t3db: fakeT3Db({
      projects: [
        {
          baseDir: "/fake/t3",
          projectId: "project-1",
          title: "t3code",
          workspaceRoot: `${root}/dev/t3code`,
          deletedAt: null,
        },
      ],
      threads: [
        thread(),
        thread({
          threadId: "thread-2",
          createdAt: at(DAY_B, 9, 0),
          updatedAt: at(DAY_B, 12, 0),
          latestUserMessageAt: at(DAY_B, 11, 0),
        }),
      ],
      turns: [
        turn({ files: [{ path: "a.ts", additions: 3, deletions: 1 }] }),
        turn({
          threadId: "thread-2",
          turnId: "turn-9",
          requestedAt: at(DAY_B, 9, 0),
          startedAt: at(DAY_B, 9, 0),
          completedAt: at(DAY_B, 9, 45),
          files: [{ path: "b.ts", additions: 8, deletions: 2 }],
        }),
      ],
      activities: [
        activity({ kind: "task.progress", taskId: "task-a", taskTitle: "Day one", tokens: 500 }),
        activity({
          threadId: "thread-2",
          createdAt: at(DAY_B, 9, 30),
          kind: "task.progress",
          taskId: "task-b",
          taskTitle: "Day two",
          tokens: 900,
        }),
      ],
    }),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "one",
        cwd: `${root}/dev/client-x`,
        eventTimes: [at(DAY_A, 14, 0), at(DAY_A, 14, 30)],
      }),
      ccSession({
        sessionId: "two",
        cwd: `${root}/dev/client-x`,
        promptHashes: [promptHash("day two work")],
        eventTimes: [at(DAY_B, 14, 0), at(DAY_B, 15, 0)],
      }),
    ]),
    repos: [
      {
        key: `${root}/dev/t3code/.git`,
        root: `${root}/dev/t3code`,
        nameWithOwner: "radroid/t3code",
        commits: [
          commit(),
          commit({
            sha: "b".repeat(40),
            shortSha: "bbbbbbb",
            at: at(DAY_B, 12, 0),
            insertions: 7,
            deletions: 3,
          }),
        ],
        mergedPrs: [
          {
            number: 66,
            title: "one",
            url: "",
            mergedAt: at(DAY_A, 13, 0),
            additions: 1,
            deletions: 1,
          },
          {
            number: 67,
            title: "two",
            url: "",
            mergedAt: at(DAY_B, 13, 0),
            additions: 2,
            deletions: 2,
          },
        ],
        warnings: [],
      },
    ],
  });

  NodeAssert.deepEqual(Object.keys(bundle.byDay), [DAY_A, DAY_B]);
  for (const field of [
    "sessions",
    "turns",
    "commits",
    "prsMerged",
    "filesTouched",
    "linesAdded",
    "linesRemoved",
    "tokens",
    "activeMs",
    "agentRuntimeMs",
    "awaitingInputMs",
  ]) {
    const summed = Object.values(bundle.byDay).reduce((total, day) => total + day[field], 0);
    NodeAssert.equal(summed, bundle.stats[field], `byDay.${field} must sum to stats.${field}`);
  }
  NodeAssert.deepEqual(bundle.byDay[DAY_A].sessionKeys.sort(), ["cc-one", "t3-thread-1"]);
  NodeAssert.deepEqual(bundle.byDay[DAY_B].sessionKeys.sort(), ["cc-two", "t3-thread-2"]);
  NodeAssert.equal(bundle.byDay[DAY_B].commits, 1);
});

NodeTest.test(
  "a range defaults to today and a bad date is a usage error, not a warning",
  async (t) => {
    const root = tempRoot(t);
    writeRegistry(root, defaultRegistry(root));
    const bundle = await collect({
      worklogRoot: root,
      now: NOW,
      includeGit: false,
      deps: baseDeps(root),
    });
    NodeAssert.equal(bundle.range.from, DAY_B);
    NodeAssert.equal(bundle.range.to, DAY_B);

    await NodeAssert.rejects(
      () =>
        collect({
          from: "2026-02-31",
          to: "2026-02-31",
          worklogRoot: root,
          includeGit: false,
          deps: baseDeps(root),
        }),
      /not a real calendar date/u,
    );
  },
);

// --- degradation --------------------------------------------------------------------------------

NodeTest.test("includeGit:false skips git entirely", async (t) => {
  const root = tempRoot(t);
  const { bundle, gitCalls } = await collectFixture(t, {
    root,
    includeGit: false,
    claudeCode: fakeClaudeCode([ccSession({ cwd: `${root}/dev/client-x` })]),
  });

  NodeAssert.deepEqual(gitCalls, []);
  NodeAssert.deepEqual(bundle.git.repos, []);
  NodeAssert.equal(bundle.config.includeGit, false);
  NodeAssert.equal(bundle.stats.commits, 0);
  NodeAssert.equal(bundle.stats.prsMerged, 0);
  // The sessions are still there — only the git evidence is missing.
  NodeAssert.equal(bundle.stats.sessions, 2);
});

NodeTest.test("a collector that throws becomes a warning instead of a failed bundle", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db({
      projects: [
        {
          baseDir: "/fake/t3",
          projectId: "project-1",
          title: "t3code",
          workspaceRoot: `${root}/dev/t3code`,
          deletedAt: null,
        },
      ],
      threads: [thread()],
      turns: [turn()],
      overrides: {
        readActivities: () => {
          throw new Error("database is locked");
        },
      },
    }),
    claudeCode: fakeClaudeCode([ccSession({ cwd: `${root}/dev/client-x` })]),
    repos: [],
  });

  NodeAssert.ok(bundle.warnings.some((warning) => warning.includes("database is locked")));
  // The turn-derived half of the thread survives, and so does the whole Claude Code side.
  NodeAssert.equal(bundle.stats.sessions, 2);
  NodeAssert.equal(bundle.sessions.find((session) => session.key === "t3-thread-1").turnCount, 1);
});

NodeTest.test("a runner passed at the top level is used instead of a fresh one", async (t) => {
  const root = tempRoot(t);
  writeRegistry(root, defaultRegistry(root));
  const seen = [];
  const bundle = await collect({
    from: DAY_A,
    to: DAY_A,
    worklogRoot: root,
    now: NOW,
    // The CLI hands its own runner in at the top level rather than under `deps`.
    run: (cmd, args) => {
      seen.push(cmd);
      return { ok: false, code: 1, stdout: "", stderr: `no ${args?.[0] ?? ""}` };
    },
    deps: {
      ...baseDeps(root),
      git: {
        collectGit: (dirs, window, options) => {
          options.run("git", ["status"]);
          return { repos: [], warnings: [] };
        },
      },
      run: undefined,
    },
  });

  NodeAssert.deepEqual(seen, ["git"]);
  NodeAssert.equal(bundle.stats.commits, 0);
});

NodeTest.test("a Claude Code scan that rejects still yields a bundle", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    claudeCode: {
      scanSessions: async () => {
        throw new Error("EMFILE: too many open files");
      },
    },
    repos: [],
  });

  NodeAssert.ok(bundle.warnings.some((warning) => warning.includes("EMFILE")));
  NodeAssert.equal(bundle.stats.sessions, 1);
});

NodeTest.test("a missing worklog repo degrades to warnings and an empty registry", async (t) => {
  const root = NodePath.join(tempRoot(t), "never-created");
  const bundle = await collect({
    from: DAY_A,
    to: DAY_A,
    worklogRoot: root,
    includeGit: false,
    now: NOW,
    deps: baseDeps(root, {
      claudeCode: fakeClaudeCode([ccSession({ cwd: "/somewhere/else" })]),
    }),
  });

  NodeAssert.ok(bundle.warnings.some((warning) => warning.includes("worklog init")));
  NodeAssert.equal(bundle.stats.sessions, 1);
  NodeAssert.equal(bundle.unclassified.length, 1);
});

NodeTest.test("warnings from the underlying readers are surfaced once", async (t) => {
  const root = tempRoot(t);
  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db({
      overrides: {
        openT3Databases: () => ({
          handles: [{ baseDir: "/fake/t3", dbPath: "/fake/t3/state.sqlite", db: {} }],
          warnings: ["Could not open /fake/t3/state.sqlite read-only: bad magic"],
        }),
        readThreads: () => {
          const rows = [];
          Object.defineProperty(rows, "warnings", {
            value: ["projection_threads is missing from /fake/t3/state.sqlite; skipping it."],
            enumerable: false,
          });
          return rows;
        },
      },
    }),
    repos: [],
  });

  NodeAssert.ok(
    bundle.warnings.includes("Could not open /fake/t3/state.sqlite read-only: bad magic"),
  );
  NodeAssert.ok(
    bundle.warnings.some((warning) => warning.includes("projection_threads is missing")),
  );
  NodeAssert.equal(new Set(bundle.warnings).size, bundle.warnings.length);
});

// --- extraction ---------------------------------------------------------------------------------

NodeTest.test("extraction is queued only for material sessions with new material", async (t) => {
  const root = tempRoot(t);
  const paths = writeRegistry(root, defaultRegistry(root));
  NodeFS.mkdirSync(paths.extracts, { recursive: true });
  // A cursor past the session's last event means nothing new happened since the last extract.
  NodeFS.writeFileSync(
    NodePath.join(paths.extracts, "cc-cached.json"),
    extractDocument("cc-cached", {
      cursorAt: at(DAY_A, 23, 0),
      problem: "flaky test",
      approach: "pinned the clock",
      outcome: "green",
      status: "done",
    }),
    "utf8",
  );
  NodeFS.writeFileSync(NodePath.join(paths.extracts, "cc-stale.json"), "{not json", "utf8");

  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "cached",
        cwd: `${root}/dev/client-x`,
        eventTimes: [at(DAY_A, 9, 0), at(DAY_A, 9, 30)],
      }),
      ccSession({
        sessionId: "stale",
        cwd: `${root}/dev/client-x`,
        promptHashes: [promptHash("stale")],
        eventTimes: [at(DAY_A, 10, 0), at(DAY_A, 10, 30)],
      }),
      ccSession({
        sessionId: "tiny",
        cwd: `${root}/dev/client-x`,
        promptCount: 1,
        toolUseCount: 0,
        promptHashes: [promptHash("tiny")],
        eventTimes: [at(DAY_A, 11, 0)],
      }),
    ]),
    repos: [],
  });

  const byKey = new Map(bundle.sessions.map((session) => [session.key, session]));
  NodeAssert.equal(byKey.get("cc-cached").needsExtraction, false);
  NodeAssert.equal(byKey.get("cc-cached").extract.extract.outcome, "green");
  NodeAssert.equal(byKey.get("cc-cached").extract.cursor.lastEventAt, at(DAY_A, 23, 0));
  // A corrupt extract reads as "never extracted" — one wasted call beats an untrustworthy cursor.
  NodeAssert.equal(byKey.get("cc-stale").needsExtraction, true);
  NodeAssert.equal(byKey.get("cc-stale").extract, null);
  NodeAssert.ok(bundle.warnings.some((warning) => warning.includes("unreadable or empty")));
  // One prompt and no tools is not material — a quiet session must cost zero model tokens.
  NodeAssert.equal(byKey.get("cc-tiny").needsExtraction, false);
  // The cached extract is about this window, so it is published rather than withheld.
  NodeAssert.equal(byKey.get("cc-cached").withheldExtract, null);
});

NodeTest.test("an extract about another day never lands in this day's bundle", async (t) => {
  const root = tempRoot(t);
  const paths = writeRegistry(root, defaultRegistry(root));
  NodeFS.mkdirSync(paths.extracts, { recursive: true });
  // Written by a /worklog run for DAY_B. Re-running for DAY_A must not file DAY_B's story under
  // DAY_A's date — an extract is per session, not per day, so only its cursor can date it.
  NodeFS.writeFileSync(
    NodePath.join(paths.extracts, "cc-later.json"),
    extractDocument("cc-later", {
      cursorAt: at(DAY_B, 18, 0),
      problem: "the relay notify 500ed after the publish applied",
      approach: "retried the notify",
      outcome: "tomorrow's outcome",
    }),
    "utf8",
  );
  // And one whose story is entirely older than the window: the day's work is unsummarised.
  NodeFS.writeFileSync(
    NodePath.join(paths.extracts, "cc-earlier.json"),
    extractDocument("cc-earlier", {
      cursorAt: at("2026-08-09", 18, 0),
      problem: "an older sync",
      approach: "rebased",
      outcome: "last week's outcome",
    }),
    "utf8",
  );

  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "later",
        cwd: `${root}/dev/client-x`,
        eventTimes: [at(DAY_A, 9, 0), at(DAY_A, 9, 30)],
      }),
      ccSession({
        sessionId: "earlier",
        cwd: `${root}/dev/client-x`,
        promptHashes: [promptHash("earlier")],
        eventTimes: [at(DAY_A, 11, 0), at(DAY_A, 11, 30)],
      }),
    ]),
    repos: [],
  });

  const byKey = new Map(bundle.sessions.map((session) => [session.key, session]));
  const later = byKey.get("cc-later");
  NodeAssert.equal(later.extract, null);
  NodeAssert.equal(later.withheldExtract.cursorAt, at(DAY_B, 18, 0));
  NodeAssert.match(later.withheldExtract.reason, /after this window/u);
  // The cursor still rules the queue: `extract-queue` re-reads the file from disk and would skip
  // this session, so the bundle must not advertise an extraction nobody would run.
  NodeAssert.equal(later.needsExtraction, false);

  const earlier = byKey.get("cc-earlier");
  NodeAssert.equal(earlier.extract, null);
  NodeAssert.match(earlier.withheldExtract.reason, /before this window/u);
  NodeAssert.equal(earlier.needsExtraction, true);

  // Withheld, not flagged: a flag only helps a reader that checks it, and every renderer would
  // have to opt in. A null cannot be misread.
  const summary = renderSummary(bundle);
  NodeAssert.ok(!summary.includes("tomorrow's outcome"));
  NodeAssert.ok(!summary.includes("last week's outcome"));
});

// --- summary ------------------------------------------------------------------------------------

NodeTest.test("the summary digests the bundle without running away", async (t) => {
  const root = tempRoot(t);
  const paths = worklogPaths(root);
  const { bundle } = await collectFixture(t, {
    root,
    claudeCode: fakeClaudeCode([
      ccSession({ cwd: `${root}/dev/client-x` }),
      ccSession({
        sessionId: "scratch",
        cwd: `${root}/dev/scratchpad`,
        promptHashes: [promptHash("scratch")],
        eventTimes: [at(DAY_A, 20, 0), at(DAY_A, 20, 30)],
      }),
    ]),
  });
  NodeFS.mkdirSync(paths.extracts, { recursive: true });

  const summary = renderSummary(bundle);
  const lines = summary.split("\n");
  NodeAssert.ok(lines.length < 400, `summary was ${lines.length} lines`);

  NodeAssert.ok(summary.startsWith(`# Worklog evidence — ${DAY_A} (`));
  NodeAssert.ok(summary.includes("## Unclassified projects (1)"));
  NodeAssert.ok(summary.includes("`scratchpad`"));
  // "excluded" would read as "the human switched this off", which is the opposite of the truth.
  NodeAssert.ok(summary.includes("### scratchpad · scratchpad · unclassified — do not name"));
  NodeAssert.ok(summary.includes("## Active blocks"));
  NodeAssert.ok(summary.includes("### t3code · T3 Code (fork) · public"));
  NodeAssert.ok(summary.includes("### client-x · Client X · private"));
  NodeAssert.ok(summary.includes("Sync fork with upstream"));
  NodeAssert.ok(summary.includes("`714b866` docs(t3x): record the capture"));
  NodeAssert.ok(summary.includes("#66 fix(t3x): retry the relay notify (+120/-14)"));
  NodeAssert.ok(summary.includes("apps/server/src/coil/relay.ts (+30/-4)"));
  NodeAssert.ok(summary.includes("## Sessions needing extraction"));
  // Paths stay repo-relative: no absolute checkout path leaks into a file list.
  NodeAssert.ok(!summary.includes(`${root}/dev/t3code/apps`));
});

NodeTest.test("the summary renders cached extracts and the excluded reason", async (t) => {
  const root = tempRoot(t);
  const paths = writeRegistry(root, defaultRegistry(root));
  NodeFS.mkdirSync(paths.extracts, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(paths.extracts, "cc-done.json"),
    extractDocument("cc-done", {
      cursorAt: at(DAY_A, 23, 0),
      problem: "The relay notify returned a 500 after the publish had already applied",
      approach: "Retried the notify and surfaced DO failures as 503s",
      outcome: "PR #66 merged",
      artifacts: ["PR #66"],
      status: "complete",
    }),
    "utf8",
  );

  const { bundle } = await collectFixture(t, {
    root,
    t3db: fakeT3Db(),
    claudeCode: fakeClaudeCode([
      ccSession({
        sessionId: "done",
        cwd: `${root}/dev/client-x`,
        eventTimes: [at(DAY_A, 9, 0), at(DAY_A, 9, 30)],
      }),
      ccSession({
        sessionId: "driven",
        cwd: `${root}/worktrees/x`,
        promptHashes: [promptHash("driven")],
        eventTimes: [at(DAY_A, 10, 0)],
      }),
    ]),
    repos: [],
  });

  const summary = renderSummary(bundle);
  NodeAssert.ok(summary.includes("## Sessions with cached extracts (1)"));
  NodeAssert.ok(summary.includes("- outcome: PR #66 merged"));
  NodeAssert.ok(summary.includes("- artifacts: PR #66"));
  NodeAssert.ok(summary.includes("[excluded: t3code-driven]"));
  NodeAssert.ok(summary.includes("None — every material session already has a current extract."));
});

NodeTest.test("renderStatLine drops the zeroes and keeps the clocks", async (t) => {
  const { bundle } = await collectFixture(t);
  const line = renderStatLine(bundle);
  NodeAssert.match(line, /^2 projects · 2 sessions · /u);
  NodeAssert.ok(line.includes("1 commit"));
  NodeAssert.ok(line.includes("1 PR merged"));
  NodeAssert.ok(line.includes("+40/-5"));
  NodeAssert.ok(line.includes("active"));
  NodeAssert.ok(line.includes("agent"));

  const empty = renderStatLine({ stats: {} });
  NodeAssert.equal(empty, "0 sessions · 0m active · 0.0h agent");
  NodeAssert.equal(renderStatLine(null), "0 sessions · 0m active · 0.0h agent");
  NodeAssert.equal(renderStatLine(undefined), "0 sessions · 0m active · 0.0h agent");
});

NodeTest.test("the summary survives a half-built bundle", () => {
  NodeAssert.ok(renderSummary({}).startsWith("# Worklog evidence — ? ("));
  NodeAssert.ok(renderSummary(null).includes("## Stats"));
  NodeAssert.ok(
    renderSummary({
      range: { from: DAY_A, to: DAY_B, days: [DAY_A, DAY_B], timezone: "UTC" },
      sessions: [{ key: "cc-x", title: "line one\nline two", needsExtraction: true }],
      projects: null,
      stats: { activeBlocks: [{ start: "nonsense", end: null, ms: "x" }] },
    }).includes("line one line two"),
  );
});
