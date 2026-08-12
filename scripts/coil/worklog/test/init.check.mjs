// Tests for lib/init.mjs — worklog-repo scaffolding and project discovery.
//
// HOME is moved to a temp directory for the whole file, and the three WORKLOG_* overrides point at
// paths that do not exist, so a bug that falls back to a default cannot reach the user's real
// ~/.t3, ~/.claude, or ~/Developer/worklog. Every T3code database is a fixture built here; every
// git repo is a throwaway in mkdtemp with the developer's global config switched off.
//
// Run with: node --test scripts/coil/worklog/test/init.test.mjs

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { DEFAULT_SCRATCH_ROOTS, discoverProjects, init, scaffold } from "../lib/init.mjs";
import { createRunner } from "../lib/git.mjs";
import { worklogPaths } from "../lib/paths.mjs";
import { classify, loadRegistry } from "../lib/registry.mjs";
import { closeDatabases, openT3Databases } from "../lib/t3db.mjs";

// --- sandbox ------------------------------------------------------------------------------------

const SANDBOX = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-")));
const SANDBOX_HOME = NodePath.join(SANDBOX, "home");
NodeFS.mkdirSync(SANDBOX_HOME, { recursive: true });

const REAL_ENV = {
  HOME: process.env.HOME,
  WORKLOG_ROOT: process.env.WORKLOG_ROOT,
  WORKLOG_T3_BASE_DIRS: process.env.WORKLOG_T3_BASE_DIRS,
  WORKLOG_CLAUDE_PROJECTS: process.env.WORKLOG_CLAUDE_PROJECTS,
};
process.env.HOME = SANDBOX_HOME;
process.env.WORKLOG_ROOT = NodePath.join(SANDBOX_HOME, "worklog-default");
process.env.WORKLOG_T3_BASE_DIRS = NodePath.join(SANDBOX_HOME, "no-such-t3");
process.env.WORKLOG_CLAUDE_PROJECTS = NodePath.join(SANDBOX_HOME, "no-such-claude");

// The default scratch roots cover every mkdtemp target, so showing that the scratch rule is not a
// blanket off switch needs one throwaway directory that lives outside all of them. `/var/tmp` is the
// standard persistent temp tree on macOS and Linux, and `tmpdir()` is `/var/folders/…` or `/tmp`, so
// the two never overlap. Null on a platform where that does not hold; the one test that needs it
// skips rather than pretending.
const OUTSIDE_SCRATCH = (() => {
  for (const base of ["/var/tmp"]) {
    let dir;
    try {
      dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(base, "worklog-outside-")));
    } catch {
      continue;
    }
    if (!DEFAULT_SCRATCH_ROOTS.some((root) => isUnderRealPath(dir, root))) return dir;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
  return null;
})();

function isUnderRealPath(child, parent) {
  let root;
  try {
    root = NodeFS.realpathSync(parent);
  } catch {
    return false;
  }
  return child === root || child.startsWith(`${root}${NodePath.sep}`);
}

const openedHandles = [];

NodeTest.after(() => {
  closeDatabases(openedHandles);
  for (const [key, value] of Object.entries(REAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  NodeFS.rmSync(SANDBOX, { recursive: true, force: true });
  if (OUTSIDE_SCRATCH !== null) NodeFS.rmSync(OUTSIDE_SCRATCH, { recursive: true, force: true });
});

let counter = 0;

/** A throwaway directory inside the sandbox; realpath'd so macOS /var vs /private/var never bites. */
function tempDir(name = "dir") {
  const dir = NodePath.join(SANDBOX, `${name}-${(counter += 1)}`);
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- git harness --------------------------------------------------------------------------------

const GIT_AVAILABLE = (() => {
  try {
    const probe = NodeChildProcess.spawnSync("git", ["--version"], { encoding: "utf8" });
    return probe.error == null && probe.status === 0;
  } catch {
    return false;
  }
})();

// The developer's own git config must not leak into a fixture: a global commit.gpgsign or hook
// template would make these assertions machine-specific.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_SYSTEM: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Raj D",
  GIT_AUTHOR_EMAIL: "raj@example.com",
  GIT_COMMITTER_NAME: "Raj D",
  GIT_COMMITTER_EMAIL: "raj@example.com",
};

// Same, minus any identity — the shape of a machine where git has never been configured.
// `user.useConfigOnly` is what stops git from inventing user@hostname and committing anyway.
const GIT_ENV_NO_IDENTITY = {
  ...GIT_ENV,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
};
for (const key of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]) {
  delete GIT_ENV_NO_IDENTITY[key];
}

function realGitRunner(env = GIT_ENV) {
  return createRunner({ env });
}

function git(cwd, args) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (result.error != null || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout;
}

/** A repo with one commit, so `git worktree add` has something to branch from. */
function makeRepo(name, { origin } = {}) {
  const root = tempDir(name);
  git(root, ["init", "-b", "main"]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), `# ${name}\n`, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial"]);
  if (origin) git(root, ["remote", "add", "origin", origin]);
  return root;
}

/**
 * A second, independent `git init` living inside `parent`'s directory tree. This is the inbox-lens
 * shape: a repo of its own that path containment would happily fold into its host.
 */
function makeNestedRepo(parent, name) {
  const root = NodePath.join(parent, "packages", name);
  NodeFS.mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), `# ${name}\n`, "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

/** Records every command; `handler` answers the ones the test cares about, everything else fails. */
function recordingRunner(handler) {
  const run = (cmd, args = [], options = {}) => {
    run.calls.push({ cmd, args: [...args], cwd: options?.cwd ?? null });
    const result = handler?.(cmd, args, options);
    return result ?? { ok: false, code: 1, stdout: "", stderr: "command not found" };
  };
  run.calls = [];
  return run;
}

function ok(stdout = "") {
  return { ok: true, code: 0, stdout, stderr: "" };
}

/**
 * A git that only knows the repos in `map` (cwd -> { toplevel, commonDir, origin }). Longest
 * matching prefix wins, so a subdirectory of a checkout resolves like the checkout does.
 */
function repoRunner(map) {
  const entries = Object.entries(map).sort((left, right) => right[0].length - left[0].length);
  return recordingRunner((cmd, args, options) => {
    if (cmd !== "git") return null;
    const cwd = options?.cwd ?? "";
    const hit = entries.find(([dir]) => cwd === dir || cwd.startsWith(`${dir}${NodePath.sep}`));
    if (!hit) return null;
    const repo = hit[1];
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repo.toplevel}\n`);
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${repo.commonDir}\n`);
    if (args[0] === "remote") return repo.origin ? ok(`${repo.origin}\n`) : null;
    return null;
  });
}

// --- T3code database fixtures ---------------------------------------------------------------

// Verbatim from the shipping schema (the two tables discovery reads).
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
];

/** Builds a state.sqlite from `projects` and `threads`, then opens it exactly as production does. */
function t3Handles({ projects = [], threads = [] } = {}) {
  const baseDir = tempDir("t3base");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "state.sqlite"));
  for (const statement of SCHEMA) db.exec(statement);

  const insertProject = db.prepare(
    `INSERT INTO projection_projects
       (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?)`,
  );
  for (const row of projects) {
    insertProject.run(
      row.projectId,
      row.title,
      row.workspaceRoot ?? "",
      row.createdAt ?? "2026-08-01T00:00:00.000Z",
      row.updatedAt ?? "2026-08-01T00:00:00.000Z",
      row.deletedAt ?? null,
    );
  }

  const insertThread = db.prepare(
    `INSERT INTO projection_threads
       (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of threads) {
    insertThread.run(
      row.threadId,
      row.projectId,
      row.title ?? "A thread",
      row.branch ?? null,
      row.worktreePath ?? null,
      row.createdAt ?? "2026-08-10T12:00:00.000Z",
      row.updatedAt ?? "2026-08-10T13:00:00.000Z",
      row.deletedAt ?? null,
    );
  }
  db.close();

  const opened = openT3Databases([baseDir]);
  NodeAssert.equal(opened.handles.length, 1, "the fixture database should open read-only");
  openedHandles.push(...opened.handles);
  return opened.handles;
}

function session(cwd, extra = {}) {
  return {
    sessionId: `cc-${(counter += 1)}`,
    cwd,
    startedAt: "2026-08-10T10:00:00.000Z",
    endedAt: "2026-08-10T11:00:00.000Z",
    excluded: null,
    ...extra,
  };
}

// --- helpers ------------------------------------------------------------------------------------

/** Every path under `dir`, relative and sorted — enough to prove nothing appeared or vanished. */
function treeOf(dir) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = NodeFS.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(NodePath.join(current, entry.name), rel);
    }
  };
  walk(dir, "");
  return out;
}

function byKey(discovered) {
  return new Map(discovered.map((project) => [project.key, project]));
}

// --- scaffold -----------------------------------------------------------------------------------

NodeTest.test(
  "scaffold builds the whole tree, writes the config files, and states the privacy rules",
  () => {
    const root = NodePath.join(tempDir("scaffold"), "worklog");
    const result = scaffold({ root, run: repoRunner({}) });
    const paths = worklogPaths(root);

    NodeAssert.equal(result.root, root);
    for (const dir of [paths.config, paths.days, paths.ranges, paths.extracts, paths.tmp]) {
      NodeAssert.ok(NodeFS.statSync(dir).isDirectory(), `${dir} should be a directory`);
    }
    for (const file of [paths.projectsYaml, paths.redactionYaml]) {
      NodeAssert.ok(result.created.includes(file), `${file} should be reported as created`);
    }
    NodeAssert.equal(result.existed.length, 0, "a fresh scaffold has nothing pre-existing");

    const gitignore = NodeFS.readFileSync(NodePath.join(root, ".gitignore"), "utf8");
    NodeAssert.match(gitignore, /^\.worklog-tmp\/$/mu);

    const readme = NodeFS.readFileSync(NodePath.join(root, "README.md"), "utf8");
    NodeAssert.match(readme, /private by default/iu);
    NodeAssert.match(readme, /no remote/iu);
    NodeAssert.match(readme, /`days\/`[\s\S]*only directory intended for eventual publication/u);
    NodeAssert.match(readme, /`extracts\/`/u);
    NodeAssert.match(readme, /config\/redaction\.yaml/u);
    NodeAssert.match(readme, /[Nn]ever/u);

    // The written registry must round-trip through the real loader, not just look like YAML.
    const { registry, warnings } = loadRegistry(paths);
    NodeAssert.deepEqual(warnings, []);
    NodeAssert.deepEqual(registry.projects, {});
    NodeAssert.equal(registry.version, 1);
  },
);

NodeTest.test("scaffold is idempotent and never clobbers a config file a human has edited", () => {
  const root = NodePath.join(tempDir("scaffold-idem"), "worklog");
  const paths = worklogPaths(root);
  scaffold({ root, run: repoRunner({}) });

  const edited = "version: 1\nprojects:\n  mine:\n    display_name: Mine\n    confirmed: true\n";
  NodeFS.writeFileSync(paths.projectsYaml, edited, "utf8");
  NodeFS.writeFileSync(NodePath.join(paths.days, "2026-08-10.md"), "# a report\n", "utf8");

  const second = scaffold({ root, run: repoRunner({}) });
  NodeAssert.deepEqual(second.created, [], "a second scaffold creates nothing");
  NodeAssert.ok(second.existed.includes(paths.projectsYaml));
  NodeAssert.equal(NodeFS.readFileSync(paths.projectsYaml, "utf8"), edited);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(paths.days, "2026-08-10.md"), "utf8"),
    "# a report\n",
  );
});

NodeTest.test("scaffold --force rewrites the README but still refuses to touch config", () => {
  const root = NodePath.join(tempDir("scaffold-force"), "worklog");
  const paths = worklogPaths(root);
  scaffold({ root, run: repoRunner({}) });

  const readme = NodePath.join(root, "README.md");
  NodeFS.writeFileSync(readme, "stale\n", "utf8");
  const edited = "version: 1\nprojects: {}\n";
  NodeFS.writeFileSync(paths.projectsYaml, edited, "utf8");

  const result = scaffold({ root, force: true, run: repoRunner({}) });
  NodeAssert.ok(result.rewritten.includes(readme));
  NodeAssert.match(NodeFS.readFileSync(readme, "utf8"), /private by default/iu);
  NodeAssert.equal(
    NodeFS.readFileSync(paths.projectsYaml, "utf8"),
    edited,
    "config survives --force",
  );
});

NodeTest.test(
  "scaffold reports a file sitting where a directory belongs instead of throwing",
  () => {
    const root = NodePath.join(tempDir("scaffold-clash"), "worklog");
    NodeFS.mkdirSync(root, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "days"), "not a directory\n", "utf8");

    const result = scaffold({ root, run: repoRunner({}) });
    NodeAssert.ok(
      result.warnings.some(
        (warning) => /Expected a directory/u.test(warning) && /days/u.test(warning),
      ),
      `expected a directory-clash warning, got ${JSON.stringify(result.warnings)}`,
    );
    NodeAssert.ok(
      NodeFS.statSync(NodePath.join(root, "config")).isDirectory(),
      "the rest still gets built",
    );
  },
);

NodeTest.test("scaffold runs git init exactly once, and not at all inside an existing repo", () => {
  const root = NodePath.join(tempDir("scaffold-git"), "worklog");

  // Nothing is a repo yet: init, add, commit.
  const fresh = recordingRunner((cmd, args) =>
    ["init", "add", "commit"].includes(args[0]) ? ok() : null,
  );
  const first = scaffold({ root, run: fresh });
  NodeAssert.equal(first.gitInitialized, true);
  NodeAssert.equal(first.committed, true);
  NodeAssert.deepEqual(
    fresh.calls.map((call) => call.args.join(" ")),
    [
      "rev-parse --show-toplevel",
      "init -b main",
      "add -A",
      `commit -m Initialise the work log repo`,
    ],
  );

  // Now git answers "this IS the toplevel": no init, no commit.
  const existing = repoRunner({
    [root]: { toplevel: root, commonDir: NodePath.join(root, ".git") },
  });
  const second = scaffold({ root, run: existing });
  NodeAssert.equal(second.gitInitialized, false);
  NodeAssert.deepEqual(
    existing.calls.map((call) => call.args[0]),
    ["rev-parse"],
  );
});

NodeTest.test(
  "scaffold falls back to a plain git init when the installed git predates `-b`",
  () => {
    const root = NodePath.join(tempDir("scaffold-old-git"), "worklog");
    const old = recordingRunner((cmd, args) => {
      if (args[0] === "init") return args.includes("-b") ? null : ok();
      return ["add", "commit"].includes(args[0]) ? ok() : null;
    });

    const result = scaffold({ root, run: old });
    NodeAssert.equal(result.gitInitialized, true);
    NodeAssert.deepEqual(
      old.calls.map((call) => call.args.slice(0, 2).join(" ")),
      ["rev-parse --show-toplevel", "init -b", "init", "add -A", "commit -m"],
    );
  },
);

NodeTest.test("scaffold warns and carries on when git is not installed at all", () => {
  const root = NodePath.join(tempDir("scaffold-no-git"), "worklog");
  const result = scaffold({ root, run: recordingRunner(() => null) });

  NodeAssert.equal(result.gitInitialized, false);
  NodeAssert.ok(
    result.warnings.some((warning) => /Could not create a git repo/u.test(warning)),
    `expected a git warning, got ${JSON.stringify(result.warnings)}`,
  );
  NodeAssert.ok(
    NodeFS.statSync(worklogPaths(root).projectsYaml).isFile(),
    "the scaffolding still landed",
  );
});

NodeTest.test(
  "scaffold really initialises a git repo and commits the scaffolding",
  { skip: !GIT_AVAILABLE },
  () => {
    const root = NodePath.join(tempDir("scaffold-real-git"), "worklog");
    const result = scaffold({ root, run: realGitRunner() });

    NodeAssert.equal(result.gitInitialized, true);
    NodeAssert.equal(result.committed, true);
    NodeAssert.deepEqual(result.warnings, []);

    const tracked = git(root, ["ls-files"]).split("\n").filter(Boolean).sort();
    NodeAssert.deepEqual(tracked, [
      ".gitignore",
      "README.md",
      "config/projects.yaml",
      "config/redaction.yaml",
    ]);
    NodeAssert.equal(git(root, ["remote"]).trim(), "", "the worklog repo must have no remote");

    // Re-running finds the repo and leaves the history alone.
    const before = git(root, ["rev-parse", "HEAD"]).trim();
    const again = scaffold({ root, run: realGitRunner() });
    NodeAssert.equal(again.gitInitialized, false);
    NodeAssert.equal(git(root, ["rev-parse", "HEAD"]).trim(), before);
  },
);

NodeTest.test(
  "scaffold warns instead of failing when git has no identity to commit with",
  { skip: !GIT_AVAILABLE },
  () => {
    const root = NodePath.join(tempDir("scaffold-no-identity"), "worklog");
    const result = scaffold({ root, run: realGitRunner(GIT_ENV_NO_IDENTITY) });

    NodeAssert.equal(result.gitInitialized, true);
    NodeAssert.equal(result.committed, false);
    NodeAssert.ok(
      result.warnings.some((warning) => /initial commit/u.test(warning)),
      `expected a commit warning, got ${JSON.stringify(result.warnings)}`,
    );
    NodeAssert.ok(
      NodeFS.statSync(NodePath.join(root, "README.md")).isFile(),
      "the scaffolding still landed",
    );
  },
);

NodeTest.test("scaffold writes nothing outside the root it was given", () => {
  const parent = tempDir("scaffold-contained");
  const root = NodePath.join(parent, "worklog");
  const homeBefore = treeOf(SANDBOX_HOME);

  scaffold({ root, run: repoRunner({}) });

  NodeAssert.deepEqual(NodeFS.readdirSync(parent), ["worklog"]);
  NodeAssert.deepEqual(treeOf(SANDBOX_HOME), homeBefore, "HOME must be untouched");
});

// --- discoverProjects ---------------------------------------------------------------------------
//
// Every fixture root below is mkdtemp'd, i.e. it sits in exactly the scratch space that
// `isUnprojectableRoot` exists to refuse. `scratchRoots: []` is the option provided for that, and it
// is switched off only here: the default list is exercised on its own terms further down, in
// "scratch space, the home directory and the filesystem root are never projects".

NodeTest.test(
  "a Claude Code worktree session folds into the T3code project's main checkout",
  { skip: !GIT_AVAILABLE },
  () => {
    const main = makeRepo("t3code", { origin: "git@github.com:radroid/t3code.git" });
    const worktree = NodePath.join(NodePath.dirname(main), "t3code-wt");
    git(main, ["worktree", "add", "-b", "feature", worktree]);
    const nested = NodePath.join(worktree, "apps", "server");
    NodeFS.mkdirSync(nested, { recursive: true });

    const discovered = discoverProjects({
      t3Handles: t3Handles({
        projects: [{ projectId: "p1", title: "T3 Code", workspaceRoot: main }],
        threads: [
          { threadId: "t1", projectId: "p1", updatedAt: "2026-08-10T09:00:00.000Z" },
          { threadId: "t2", projectId: "p1", updatedAt: "2026-08-10T15:00:00.000Z" },
        ],
      }),
      // The session's cwd is a subdirectory of the worktree — the shape a real session has.
      ccSessions: [session(nested)],
      run: realGitRunner(),
      scratchRoots: [],
    });

    NodeAssert.equal(discovered.length, 1, "one repo, one entry");
    const [project] = discovered;
    NodeAssert.equal(project.key, "t3-code");
    NodeAssert.equal(project.displayName, "T3 Code");
    NodeAssert.deepEqual(
      project.roots,
      [main, worktree],
      "the main checkout leads, the worktree follows",
    );
    NodeAssert.equal(project.evidence.t3Threads, 2);
    NodeAssert.equal(project.evidence.ccSessions, 1);
    NodeAssert.equal(project.evidence.nameWithOwner, "radroid/t3code");
    NodeAssert.equal(project.evidence.lastSeen, "2026-08-10T15:00:00.000Z");
    NodeAssert.deepEqual(project.proposed, {
      include: true,
      visibility: "generic",
      confirmed: false,
    });
  },
);

NodeTest.test("two T3code rows that canonicalise to the same repo merge into one entry", () => {
  const main = tempDir("repo-main");
  const linked = tempDir("repo-linked");
  const commonDir = NodePath.join(main, ".git");
  NodeFS.mkdirSync(commonDir, { recursive: true });

  const discovered = discoverProjects({
    t3Handles: t3Handles({
      projects: [
        { projectId: "p1", title: "t3code", workspaceRoot: main },
        { projectId: "p2", title: "t3code", workspaceRoot: linked },
      ],
      threads: [
        { threadId: "t1", projectId: "p1" },
        { threadId: "t2", projectId: "p2" },
        { threadId: "t3", projectId: "p2" },
      ],
    }),
    ccSessions: [],
    run: repoRunner({
      [main]: { toplevel: main, commonDir },
      [linked]: { toplevel: linked, commonDir },
    }),
    scratchRoots: [],
  });

  NodeAssert.equal(discovered.length, 1);
  NodeAssert.equal(discovered[0].key, "t3code");
  NodeAssert.deepEqual(discovered[0].roots, [main, linked]);
  NodeAssert.equal(discovered[0].evidence.t3Threads, 3, "both rows' threads count once, together");
});

NodeTest.test("two same-titled projects in different repos get distinct keys", () => {
  const first = tempDir("client-a");
  const second = tempDir("client-b");

  const discovered = discoverProjects({
    t3Handles: t3Handles({
      projects: [
        { projectId: "p1", title: "dashboard", workspaceRoot: first },
        { projectId: "p2", title: "dashboard", workspaceRoot: second },
      ],
      threads: [
        { threadId: "t1", projectId: "p1" },
        { threadId: "t2", projectId: "p2" },
      ],
    }),
    ccSessions: [],
    run: repoRunner({
      [first]: { toplevel: first, commonDir: NodePath.join(first, ".git") },
      [second]: { toplevel: second, commonDir: NodePath.join(second, ".git") },
    }),
    scratchRoots: [],
  });

  NodeAssert.deepEqual(
    discovered.map((project) => project.key),
    ["dashboard", "dashboard-2"],
  );
  NodeAssert.deepEqual(
    discovered.map((project) => project.displayName),
    ["dashboard", "dashboard"],
  );
  NodeAssert.deepEqual(discovered[0].roots, [first]);
  NodeAssert.deepEqual(discovered[1].roots, [second]);
});

NodeTest.test(
  "discovery reuses the registry key that already owns a root, and adopts a rootless entry",
  () => {
    const known = tempDir("known-project");
    const nested = NodePath.join(known, "packages", "api");
    NodeFS.mkdirSync(nested, { recursive: true });
    const rootless = tempDir("side-project");

    const discovered = discoverProjects({
      t3Handles: t3Handles({
        projects: [
          { projectId: "p1", title: "Renamed By A Human", workspaceRoot: known },
          { projectId: "p2", title: "Side Project", workspaceRoot: rootless },
        ],
        threads: [
          { threadId: "t1", projectId: "p1" },
          { threadId: "t2", projectId: "p2" },
        ],
      }),
      ccSessions: [session(nested)],
      run: repoRunner({
        [known]: { toplevel: known, commonDir: NodePath.join(known, ".git") },
        [rootless]: { toplevel: rootless, commonDir: NodePath.join(rootless, ".git") },
      }),
      scratchRoots: [],
      existingRegistry: {
        projects: {
          "client-x": {
            displayName: "Client X",
            roots: [known],
            visibility: "public",
            confirmed: true,
          },
          // A human wrote this one by hand and never looked up the path.
          "side-project": { displayName: "Side Project", roots: [] },
        },
      },
    });

    const found = byKey(discovered);
    NodeAssert.deepEqual([...found.keys()], ["client-x", "side-project"]);
    NodeAssert.equal(
      found.get("client-x").evidence.ccSessions,
      1,
      "a subdirectory session lands on the repo",
    );
    NodeAssert.deepEqual(found.get("side-project").roots, [rootless]);
  },
);

NodeTest.test("a project whose only rows are deleted is not proposed", () => {
  const gone = tempDir("deleted-project");
  const live = tempDir("live-project");

  const discovered = discoverProjects({
    t3Handles: t3Handles({
      projects: [
        {
          projectId: "p1",
          title: "Gone",
          workspaceRoot: gone,
          deletedAt: "2026-08-01T00:00:00.000Z",
        },
        { projectId: "p2", title: "Live", workspaceRoot: live },
      ],
      threads: [
        { threadId: "t1", projectId: "p1", deletedAt: "2026-08-01T00:00:00.000Z" },
        { threadId: "t2", projectId: "p2" },
        { threadId: "t3", projectId: "p2", deletedAt: "2026-08-02T00:00:00.000Z" },
      ],
    }),
    ccSessions: [],
    run: repoRunner({}),
    scratchRoots: [],
  });

  NodeAssert.deepEqual(
    discovered.map((project) => project.key),
    ["live"],
  );
  NodeAssert.equal(discovered[0].evidence.t3Threads, 1, "deleted threads are not evidence");
});

NodeTest.test(
  "a deleted project still on disk is proposed again when a session is running in it",
  () => {
    const revived = tempDir("revived-project");

    const discovered = discoverProjects({
      t3Handles: t3Handles({
        projects: [
          {
            projectId: "p1",
            title: "Revived",
            workspaceRoot: revived,
            deletedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      ccSessions: [session(revived)],
      run: repoRunner({}),
      scratchRoots: [],
    });

    NodeAssert.deepEqual(
      discovered.map((project) => project.key),
      ["revived"],
    );
    NodeAssert.equal(discovered[0].evidence.ccSessions, 1);
  },
);

NodeTest.test("discovery survives a machine with no git, no database, and junk sessions", () => {
  const plain = tempDir("no-git-here");
  const brokenRunner = recordingRunner(() => ({
    ok: false,
    code: 127,
    stdout: "",
    stderr: "git: not found",
  }));

  const discovered = discoverProjects({
    t3Handles: undefined,
    // A deleted worktree is the normal end state of a T3code thread, so a stale cwd must not
    // become a project of its own.
    ccSessions: [null, {}, session(""), session(plain), session(plain), session("/nope/gone")],
    run: brokenRunner,
    scratchRoots: [],
  });

  NodeAssert.deepEqual(
    discovered.map((project) => project.key),
    [NodePath.basename(plain)],
  );
  NodeAssert.deepEqual(discovered[0].roots, [plain]);
  NodeAssert.equal(discovered[0].evidence.ccSessions, 2);
  NodeAssert.equal(discovered[0].evidence.nameWithOwner, null);
  NodeAssert.equal(discovered[0].evidence.t3Threads, 0);
});

NodeTest.test("discovery tolerates being called with nothing at all", () => {
  NodeAssert.deepEqual(discoverProjects(), []);
  NodeAssert.deepEqual(discoverProjects({}), []);
  NodeAssert.deepEqual(discoverProjects({ t3Handles: "nope", ccSessions: "nope" }), []);
});

NodeTest.test("a T3code project with no workspace root still gets an entry of its own", () => {
  const discovered = discoverProjects({
    t3Handles: t3Handles({
      projects: [
        { projectId: "p1", title: "Rootless", workspaceRoot: "" },
        { projectId: "p2", title: "Rootless", workspaceRoot: "" },
      ],
      threads: [
        { threadId: "t1", projectId: "p1" },
        { threadId: "t2", projectId: "p2" },
      ],
    }),
    ccSessions: [],
    run: repoRunner({}),
  });

  NodeAssert.deepEqual(
    discovered.map((project) => project.key),
    ["rootless", "rootless-2"],
  );
  NodeAssert.deepEqual(discovered[0].roots, []);
});

NodeTest.test("discovery resolves each directory once no matter how many sessions share it", () => {
  const dir = tempDir("busy-project");
  const runner = repoRunner({ [dir]: { toplevel: dir, commonDir: NodePath.join(dir, ".git") } });

  discoverProjects({
    t3Handles: t3Handles({ projects: [{ projectId: "p1", title: "Busy", workspaceRoot: dir }] }),
    ccSessions: [session(dir), session(dir), session(dir), session(dir)],
    run: runner,
    scratchRoots: [],
  });

  const toplevelCalls = runner.calls.filter((call) => call.args[1] === "--show-toplevel");
  NodeAssert.equal(toplevelCalls.length, 1, "canonicalRepo is memoised per directory");
});

// --- scratch, home and the filesystem root (DEFAULT scratchRoots) --------------------------------
//
// Real session cwds include `~`, `/`, and scratch directories. An entry rooted at any of those wins
// every `matchProjectByRoot` containment test, so it silently claims other projects' sessions — and
// because an unconfirmed project still counts toward the totals, the misattribution is invisible.

NodeTest.test(
  "scratch space, the home directory and the filesystem root are never projects",
  {
    skip:
      OUTSIDE_SCRATCH === null ? "no writable directory outside the default scratch roots" : false,
  },
  () => {
    // Deliberately no `scratchRoots` argument: this is the test that runs on the real defaults.
    const scratch = tempDir("scratch-session"); // inside os.tmpdir(), i.e. a default scratch root
    const fakeHome = tempDir("fake-home");
    const filesystemRoot = NodePath.parse(scratch).root;
    const real = NodePath.join(OUTSIDE_SCRATCH, "acme-api");
    NodeFS.mkdirSync(real, { recursive: true });

    const runner = recordingRunner(() => null);
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    let discovered;
    try {
      discovered = discoverProjects({
        ccSessions: [session(fakeHome), session(scratch), session(filesystemRoot), session(real)],
        run: runner,
      });
    } finally {
      process.env.HOME = previousHome;
    }

    // Three of the four sessions propose nothing; the fourth is an ordinary project and still does,
    // so the rule is a filter and not a blanket off switch.
    NodeAssert.deepEqual(
      discovered.map((project) => project.key),
      ["acme-api"],
    );
    NodeAssert.deepEqual(discovered[0].roots, [real]);
    NodeAssert.equal(discovered[0].evidence.ccSessions, 1);
    NodeAssert.equal(discovered[0].evidence.t3Threads, 0);

    // A rejected directory is rejected before anything is spawned against it.
    NodeAssert.deepEqual([...new Set(runner.calls.map((call) => call.cwd))], [real]);
  },
);

NodeTest.test("the home directory is rejected for being home, not for being scratch", () => {
  const fakeHome = tempDir("home-rejected");
  const inside = NodePath.join(fakeHome, "Developer", "acme-api");
  NodeFS.mkdirSync(inside, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  let discovered;
  try {
    discovered = discoverProjects({
      // `~` is the spelling a hand-written config uses, and it must be expanded before the check.
      ccSessions: [session(fakeHome), session("~"), session(inside)],
      run: recordingRunner(() => null),
      // Scratch is switched off, so `fakeHome` can only be refused on its own account.
      scratchRoots: [],
    });
  } finally {
    process.env.HOME = previousHome;
  }

  // `inside` is what proves the rule is the home directory itself rather than containment:
  // ~/Developer/acme-api is where projects actually live.
  NodeAssert.deepEqual(
    discovered.map((project) => project.key),
    ["acme-api"],
  );
  NodeAssert.deepEqual(discovered[0].roots, [inside]);
  NodeAssert.equal(discovered[0].evidence.ccSessions, 1);
});

// --- nested repositories -------------------------------------------------------------------------

NodeTest.test(
  "a repo nested inside another repo's tree is its own project, while a linked worktree is not",
  { skip: !GIT_AVAILABLE },
  () => {
    const parent = makeRepo("mission-control");
    const nested = makeNestedRepo(parent, "inbox-lens");
    NodeFS.mkdirSync(NodePath.join(nested, "src"), { recursive: true });

    // The contrast case: a different directory, but one shared object store.
    const worktree = NodePath.join(NodePath.dirname(parent), "mission-control-wt");
    git(parent, ["worktree", "add", "-b", "feature", worktree]);

    const discovered = discoverProjects({
      t3Handles: t3Handles({
        projects: [
          { projectId: "p1", title: "Mission Control", workspaceRoot: parent },
          { projectId: "p2", title: "Inbox Lens", workspaceRoot: nested },
        ],
        threads: [
          { threadId: "t1", projectId: "p1" },
          { threadId: "t2", projectId: "p2" },
        ],
      }),
      ccSessions: [session(worktree), session(NodePath.join(nested, "src"))],
      run: realGitRunner(),
      scratchRoots: [],
    });

    const found = byKey(discovered);
    NodeAssert.deepEqual(
      [...found.keys()],
      ["mission-control", "inbox-lens"],
      "two repos, two keys",
    );
    const host = found.get("mission-control");
    const guest = found.get("inbox-lens");

    // Neither entry may hold the other's root: that is what folded inbox-lens' work into its host.
    NodeAssert.deepEqual(guest.roots, [nested]);
    NodeAssert.ok(!host.roots.includes(nested), `mission-control must not claim ${nested}`);
    NodeAssert.ok(!guest.roots.includes(parent), `inbox-lens must not claim ${parent}`);
    NodeAssert.equal(guest.displayName, "Inbox Lens");
    NodeAssert.equal(guest.evidence.t3Threads, 1);
    NodeAssert.equal(guest.evidence.ccSessions, 1, "a session under the nested repo belongs to it");
    NodeAssert.equal(host.evidence.t3Threads, 1);
    NodeAssert.equal(host.evidence.ccSessions, 1, "and the worktree session belongs to the host");

    // The complementary case: a linked worktree shares an object store, which proves it is the same
    // project, so it folds in as a second root instead of becoming a third entry.
    NodeAssert.deepEqual(host.roots, [parent, worktree]);
  },
);

// --- init ---------------------------------------------------------------------------------------

/**
 * `init` with a real git for the worklog repo; discovered roots are plain, non-repo directories.
 * `scratchRoots: []` for the same reason discovery's own tests pass it: the fixtures are mkdtemp'd,
 * and the default list refuses to propose anything inside scratch space.
 */
async function runInit(root, extra = {}) {
  return init({ root, deps: { run: realGitRunner(), ccSessions: [], scratchRoots: [], ...extra } });
}

NodeTest.test("init scaffolds, proposes every discovered project, and confirms none", async () => {
  const root = NodePath.join(tempDir("init"), "worklog");
  const alpha = tempDir("alpha");
  const beta = tempDir("beta");

  const result = await runInit(root, {
    t3Handles: t3Handles({
      projects: [
        { projectId: "p1", title: "Alpha", workspaceRoot: alpha },
        { projectId: "p2", title: "Beta", workspaceRoot: beta },
      ],
      threads: [{ threadId: "t1", projectId: "p1" }],
    }),
    ccSessions: [session(beta)],
  });

  NodeAssert.equal(result.root, root);
  NodeAssert.equal(result.registryPath, worklogPaths(root).projectsYaml);
  NodeAssert.deepEqual(result.added.sort(), ["alpha", "beta"]);
  NodeAssert.deepEqual(result.unchanged, []);
  NodeAssert.deepEqual(result.warnings, []);
  NodeAssert.equal(result.discovered.length, 2);

  const { registry } = loadRegistry(worklogPaths(root));
  for (const key of ["alpha", "beta"]) {
    const entry = registry.projects[key];
    NodeAssert.equal(entry.include, true);
    NodeAssert.equal(entry.visibility, "generic");
    NodeAssert.equal(entry.confirmed, false);
    // Fails closed all the way to the classifier: unconfirmed means not describable.
    NodeAssert.equal(classify(registry, key).effective, "unconfirmed");
  }
  NodeAssert.equal(registry.projects.alpha.displayName, "Alpha");
  NodeAssert.deepEqual(registry.projects.beta.roots, [beta]);
});

NodeTest.test("re-running init adds nothing and preserves a human's edits", async () => {
  const root = NodePath.join(tempDir("init-idem"), "worklog");
  const alpha = tempDir("alpha");
  const deps = {
    t3Handles: t3Handles({
      projects: [{ projectId: "p1", title: "Alpha", workspaceRoot: alpha }],
      threads: [{ threadId: "t1", projectId: "p1" }],
    }),
  };

  await runInit(root, deps);
  const paths = worklogPaths(root);

  // The human promotes the project and renames it — exactly what init must never undo. The
  // indent-anchored patterns matter: the file's comment header also contains "visibility: generic".
  const edited = NodeFS.readFileSync(paths.projectsYaml, "utf8")
    .replace("\n    visibility: generic", "\n    visibility: public")
    .replace("\n    confirmed: false", "\n    confirmed: true")
    .replace("\n    display_name: Alpha", "\n    display_name: Alpha (my fork)");
  NodeFS.writeFileSync(paths.projectsYaml, edited, "utf8");
  NodeAssert.match(
    edited,
    /\n {4}visibility: public\n/u,
    "the fixture edit must actually have applied",
  );

  const second = await runInit(root, deps);
  NodeAssert.deepEqual(second.added, []);
  NodeAssert.deepEqual(second.updated, []);
  NodeAssert.deepEqual(second.unchanged, ["alpha"]);
  NodeAssert.deepEqual(second.created, [], "the tree already exists");

  NodeAssert.equal(
    NodeFS.readFileSync(paths.projectsYaml, "utf8"),
    edited,
    "an unchanged registry is not rewritten, so hand-written comments survive",
  );
  const { registry } = loadRegistry(paths);
  NodeAssert.equal(registry.projects.alpha.visibility, "public");
  NodeAssert.equal(registry.projects.alpha.confirmed, true);
  NodeAssert.equal(registry.projects.alpha.displayName, "Alpha (my fork)");
  NodeAssert.equal(classify(registry, "alpha").effective, "public");
});

NodeTest.test(
  "init adds a newly discovered root to an existing entry without touching its visibility",
  async () => {
    const root = NodePath.join(tempDir("init-grow"), "worklog");
    const alpha = tempDir("alpha");
    const alphaTwo = tempDir("alpha-second-checkout");

    await runInit(root, {
      t3Handles: t3Handles({
        projects: [{ projectId: "p1", title: "Alpha", workspaceRoot: alpha }],
      }),
    });
    const paths = worklogPaths(root);
    const promoted = NodeFS.readFileSync(paths.projectsYaml, "utf8").replace(
      "\n    confirmed: false",
      "\n    confirmed: true",
    );
    NodeFS.writeFileSync(paths.projectsYaml, promoted, "utf8");
    NodeAssert.match(
      promoted,
      /\n {4}confirmed: true\n/u,
      "the fixture edit must actually have applied",
    );

    const second = await runInit(root, {
      t3Handles: t3Handles({
        projects: [
          { projectId: "p1", title: "Alpha", workspaceRoot: alpha },
          { projectId: "p2", title: "Alpha", workspaceRoot: alphaTwo },
        ],
      }),
      // Both checkouts share one object store, so they are one project with two roots.
      run: (() => {
        const commonDir = NodePath.join(alpha, ".git");
        const runner = repoRunner({
          [alpha]: { toplevel: alpha, commonDir },
          [alphaTwo]: { toplevel: alphaTwo, commonDir },
        });
        return (cmd, args, options) => {
          // Everything that is not one of the two fixture repos falls through to real git, so the
          // worklog repo itself is still initialised for real.
          const result = runner(cmd, args, options);
          return result.ok ? result : realGitRunner()(cmd, args, options);
        };
      })(),
    });

    NodeAssert.deepEqual(second.added, []);
    NodeAssert.deepEqual(second.updated, ["alpha"]);
    const { registry } = loadRegistry(paths);
    NodeAssert.deepEqual(registry.projects.alpha.roots, [alpha, alphaTwo]);
    NodeAssert.equal(registry.projects.alpha.confirmed, true, "the human's promotion survives");
  },
);

NodeTest.test(
  "init degrades to warnings when the databases and transcripts are missing",
  async () => {
    const root = NodePath.join(tempDir("init-empty"), "worklog");
    const result = await init({
      root,
      deps: {
        run: realGitRunner(),
        t3BaseDirs: [NodePath.join(SANDBOX_HOME, "no-such-t3")],
        claudeProjectsDir: NodePath.join(SANDBOX_HOME, "no-such-claude"),
      },
    });

    NodeAssert.deepEqual(result.discovered, []);
    NodeAssert.deepEqual(result.added, []);
    NodeAssert.ok(
      result.warnings.some((warning) => /Claude Code projects directory not found/u.test(warning)),
      `expected a missing-transcripts warning, got ${JSON.stringify(result.warnings)}`,
    );
    NodeAssert.ok(
      NodeFS.statSync(worklogPaths(root).projectsYaml).isFile(),
      "the repo is still usable",
    );
  },
);

NodeTest.test("init survives a transcript scanner that rejects", async () => {
  const root = NodePath.join(tempDir("init-scan-fail"), "worklog");
  const result = await init({
    root,
    deps: {
      run: realGitRunner(),
      t3Handles: [],
      scanSessions: async () => {
        throw new Error("disk on fire");
      },
    },
  });

  NodeAssert.deepEqual(result.discovered, []);
  NodeAssert.ok(result.warnings.some((warning) => /disk on fire/u.test(warning)));
});

NodeTest.test(
  "init gives a nested repo its own entry instead of adopting its parent's key",
  { skip: !GIT_AVAILABLE },
  async () => {
    const root = NodePath.join(tempDir("init-nested"), "worklog");
    const parent = makeRepo("mission-control");
    const nested = makeNestedRepo(parent, "inbox-lens");

    const first = await runInit(root, {
      t3Handles: t3Handles({
        projects: [{ projectId: "p1", title: "Mission Control", workspaceRoot: parent }],
        threads: [{ threadId: "t1", projectId: "p1" }],
      }),
    });
    NodeAssert.deepEqual(first.added, ["mission-control"]);

    // The nested repo now shows up, with the registry already holding a root that CONTAINS it.
    const second = await runInit(root, {
      t3Handles: t3Handles({
        projects: [
          { projectId: "p1", title: "Mission Control", workspaceRoot: parent },
          { projectId: "p2", title: "Inbox Lens", workspaceRoot: nested },
        ],
        threads: [
          { threadId: "t1", projectId: "p1" },
          { threadId: "t2", projectId: "p2" },
        ],
      }),
    });

    NodeAssert.deepEqual(
      second.added,
      ["inbox-lens"],
      "the nested repo is a new project, not its parent",
    );
    NodeAssert.deepEqual(second.updated, []);
    NodeAssert.deepEqual(second.unchanged, ["mission-control"]);

    const { registry } = loadRegistry(worklogPaths(root));
    NodeAssert.deepEqual(Object.keys(registry.projects).sort(), ["inbox-lens", "mission-control"]);
    // The host must not have absorbed the guest's root, or the guest's work is credited to it.
    NodeAssert.deepEqual(registry.projects["mission-control"].roots, [parent]);
    NodeAssert.deepEqual(registry.projects["inbox-lens"].roots, [nested]);
    NodeAssert.equal(registry.projects["inbox-lens"].displayName, "Inbox Lens");
    NodeAssert.equal(registry.projects["inbox-lens"].confirmed, false);
  },
);

NodeTest.test("init writes nothing outside the root it was given", async () => {
  const parent = tempDir("init-contained");
  const root = NodePath.join(parent, "worklog");
  const alpha = tempDir("alpha");
  const homeBefore = treeOf(SANDBOX_HOME);
  const alphaBefore = treeOf(alpha);

  await runInit(root, {
    t3Handles: t3Handles({ projects: [{ projectId: "p1", title: "Alpha", workspaceRoot: alpha }] }),
    ccSessions: [session(alpha)],
  });

  NodeAssert.deepEqual(treeOf(SANDBOX_HOME), homeBefore, "HOME must be untouched");
  NodeAssert.deepEqual(treeOf(alpha), alphaBefore, "a discovered project is only ever read");
  NodeAssert.deepEqual(NodeFS.readdirSync(parent), ["worklog"]);
});
