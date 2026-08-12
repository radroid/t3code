// Tests for lib/git.mjs. Real throwaway repos in mkdtemp dirs exercise the git parsing; every
// `gh` path is driven through a fake runner, so the suite is offline and never reads the user's
// repositories. Run with: node --test scripts/coil/worklog/test/git.test.mjs

import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  canonicalRepo,
  collectGit,
  commitsInWindow,
  createRunner,
  githubLoginIdentity,
  mergedPrs,
  remoteNameWithOwner,
} from "../lib/git.mjs";

// --- harness ------------------------------------------------------------------------------------

const GIT_AVAILABLE = (() => {
  try {
    const probe = NodeChildProcess.spawnSync("git", ["--version"], { encoding: "utf8" });
    return probe.error == null && probe.status === 0;
  } catch {
    return false;
  }
})();

// The fixture repos must not inherit the developer's global git config: a user-level
// `commit.gpgsign`, `init.defaultBranch`, or hook template would make the assertions machine-specific.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NodeOS.devNull,
  GIT_CONFIG_SYSTEM: NodeOS.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const WINDOW_START = "2026-08-10T00:00:00Z";
const WINDOW_END = "2026-08-11T00:00:00Z";
const RAJ_NAME = "Raj D";
const RAJ_EMAIL = "25481060+radroid@users.noreply.github.com";
const OTHER_NAME = "Someone Else";
const OTHER_EMAIL = "other@example.com";

/** Make a temp directory that is removed when the test finishes; realpath'd for macOS /var. */
function tempDir(t) {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-")));
  t.after(() => {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function git(cwd, args, extraEnv = {}) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...GIT_ENV, ...extraEnv },
  });
  if (result.error != null || result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout;
}

function initRepo(dir) {
  NodeFS.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["config", "user.name", RAJ_NAME]);
  git(dir, ["config", "user.email", RAJ_EMAIL]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitFixture(dir, spec) {
  for (const args of spec.gitBefore ?? []) git(dir, args);
  for (const [rel, contents] of Object.entries(spec.files ?? {})) {
    const target = NodePath.join(dir, rel);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", spec.message], {
    GIT_AUTHOR_NAME: spec.name ?? RAJ_NAME,
    GIT_AUTHOR_EMAIL: spec.email ?? RAJ_EMAIL,
    GIT_COMMITTER_NAME: spec.name ?? RAJ_NAME,
    GIT_COMMITTER_EMAIL: spec.email ?? RAJ_EMAIL,
    GIT_AUTHOR_DATE: spec.authorDate,
    GIT_COMMITTER_DATE: spec.committerDate ?? spec.authorDate,
  });
}

/** A runner stand-in that records every call and answers from `handler`. */
function fakeRunner(handler) {
  const calls = [];
  const run = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, options });
    return handler(cmd, args, options) ?? missingBinary(cmd);
  };
  run.calls = calls;
  return run;
}

const okReply = (stdout) => ({ ok: true, code: 0, stdout, stderr: "" });
const missingBinary = (cmd) => ({
  ok: false,
  code: null,
  stdout: "",
  stderr: `spawnSync ${cmd} ENOENT`,
});

const subjectsOf = (commits) => commits.map((commit) => commit.subject);
const findBySubject = (commits, subject) => commits.find((commit) => commit.subject === subject);

// The fixture history. Dates are absolute UTC so the assertions hold in any timezone.
function buildHistory(dir) {
  initRepo(dir);
  commitFixture(dir, {
    message: "root: add notes",
    authorDate: "2026-08-10T09:00:00Z",
    files: { "notes.md": "a\nb\nc\n", "deep/nest/f.txt": "x\n" },
  });
  commitFixture(dir, {
    message: "colleague tweak",
    name: OTHER_NAME,
    email: OTHER_EMAIL,
    authorDate: "2026-08-10T10:00:00Z",
    files: { "notes.md": "a\nb\nc\nd\n" },
  });
  commitFixture(dir, {
    message: "before the window",
    authorDate: "2026-08-09T09:00:00Z",
    files: { "early.txt": "e\n" },
  });
  commitFixture(dir, {
    message: "add a binary blob",
    authorDate: "2026-08-10T11:00:00Z",
    files: { "blob.bin": Buffer.from([0, 1, 2, 0, 255, 0, 7, 9]) },
  });
  commitFixture(dir, {
    message: "rename the nested file",
    authorDate: "2026-08-10T12:00:00Z",
    gitBefore: [["mv", "deep/nest/f.txt", "deep/nest/g.txt"]],
  });
  // Author date in-window, committer date two weeks later: exactly what a rebase produces on this
  // fork, and the case a naive `--since/--until` filter drops.
  commitFixture(dir, {
    message: "rebased later",
    authorDate: "2026-08-10T13:00:00Z",
    committerDate: "2026-08-25T00:00:00Z",
    files: { "rebased.txt": "r\n" },
  });
  // `{deep => deepen}/nest/g.txt` — the brace rename shape.
  commitFixture(dir, {
    message: "hoist the directory",
    authorDate: "2026-08-10T15:00:00Z",
    gitBefore: [["mv", "deep", "deepen"]],
  });
  // `notes.md => journal.md` — the arrow rename shape, carrying real churn.
  commitFixture(dir, {
    message: "rename and extend the notes",
    authorDate: "2026-08-10T16:00:00Z",
    gitBefore: [["mv", "notes.md", "journal.md"]],
    files: { "journal.md": "a\nb\nc\nd\ne\n" },
  });
  git(dir, ["checkout", "-q", "-b", "feature/window"]);
  commitFixture(dir, {
    message: "branch work",
    authorDate: "2026-08-10T14:00:00Z",
    files: { "feature.txt": "f\n" },
  });
  git(dir, ["checkout", "-q", "main"]);

  // A T3code checkpoint: T3 commits one of these per turn under refs/t3/, so a repo it manages
  // accumulates hundreds of them. Reachable from nothing but that ref, exactly as the real ones are.
  git(dir, ["checkout", "-q", "-b", "checkpoint-holder"]);
  commitFixture(dir, {
    message: "t3 checkpoint ref=refs/t3/checkpoints/NmU3YjU0MWIt/turn/5",
    name: "T3 Code",
    email: "t3code@users.noreply.github.com",
    authorDate: "2026-08-10T17:00:00Z",
    files: { "checkpoint.txt": "c\n" },
  });
  git(dir, ["update-ref", "refs/t3/checkpoints/NmU3YjU0MWIt/turn/5", "HEAD"]);
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["branch", "-q", "-D", "checkpoint-holder"]);

  // A stash entry, authored by the user and dated inside the window, so only the refs/stash
  // exclusion can keep it out of the report.
  NodeFS.writeFileSync(NodePath.join(dir, "journal.md"), "a\nb\nc\nd\ne\nstashed\n");
  git(dir, ["stash", "push", "-q", "-m", "wip"], {
    GIT_AUTHOR_NAME: RAJ_NAME,
    GIT_AUTHOR_EMAIL: RAJ_EMAIL,
    GIT_COMMITTER_NAME: RAJ_NAME,
    GIT_COMMITTER_EMAIL: RAJ_EMAIL,
    GIT_AUTHOR_DATE: "2026-08-10T18:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-10T18:00:00Z",
  });
  return dir;
}

// A sync-shaped history: one patch that exists twice because it was replayed onto a base upstream
// had moved, with the pre-sync recovery tag keeping the original reachable. `git log --all` walks
// both copies, and on the real fork ~91 patches land in this shape at every sync.
function buildReplayedHistory(dir, { originalCommitterDate, copyCommitterDate, keepBranch }) {
  initRepo(dir);
  commitFixture(dir, {
    message: "base",
    authorDate: "2026-08-10T08:00:00Z",
    files: { "base.txt": "b\n" },
  });
  git(dir, ["checkout", "-q", "-b", "pre-sync"]);
  commitFixture(dir, {
    message: "fix(t3x): the patch that gets replayed",
    authorDate: "2026-08-10T10:00:00Z",
    committerDate: originalCommitterDate,
    files: { "patch.txt": "p\np\n" },
  });
  const original = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["tag", "coil/pre-sync-20260810"]);
  git(dir, ["checkout", "-q", "main"]);
  commitFixture(dir, {
    message: "upstream moves the base",
    authorDate: "2026-08-10T09:00:00Z",
    files: { "upstream.txt": "u\n" },
  });
  // A cherry-pick is a rebase copy in miniature: same author, same author date, same subject, new
  // SHA and a new committer date.
  git(dir, ["cherry-pick", original], { GIT_COMMITTER_DATE: copyCommitterDate });
  const copy = git(dir, ["rev-parse", "HEAD"]).trim();
  if (!keepBranch) git(dir, ["branch", "-q", "-D", "pre-sync"]);
  return { original, copy };
}

function windowCommits(dir, identities = []) {
  return commitsInWindow(
    dir,
    { start: WINDOW_START, end: WINDOW_END, identities },
    createRunner({ env: GIT_ENV }),
  );
}

// --- createRunner -------------------------------------------------------------------------------

NodeTest.test("createRunner captures stdout on success", () => {
  const run = createRunner();
  const result = run(process.execPath, ["-e", "process.stdout.write('hello')"]);
  NodeAssert.equal(result.ok, true);
  NodeAssert.equal(result.code, 0);
  NodeAssert.equal(result.stdout, "hello");
});

NodeTest.test("createRunner reports a non-zero exit as data, not a throw", () => {
  const run = createRunner();
  const result = run(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
  NodeAssert.equal(result.ok, false);
  NodeAssert.equal(result.code, 3);
  NodeAssert.match(result.stderr, /boom/u);
});

NodeTest.test("createRunner survives a missing binary", () => {
  const run = createRunner();
  const result = run("t3x-worklog-no-such-binary", ["--version"]);
  NodeAssert.equal(result.ok, false);
  NodeAssert.equal(result.code, null);
  NodeAssert.equal(result.stdout, "");
  NodeAssert.notEqual(result.stderr, "");
});

NodeTest.test("createRunner survives a directory that does not exist", () => {
  const run = createRunner();
  const result = run(process.execPath, ["-e", "0"], {
    cwd: NodePath.join(NodeOS.tmpdir(), "worklog-absent-dir-xyz"),
  });
  NodeAssert.equal(result.ok, false);
});

NodeTest.test("createRunner enforces its timeout without throwing", () => {
  const run = createRunner({ timeoutMs: 200 });
  const result = run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  NodeAssert.equal(result.ok, false);
});

NodeTest.test("createRunner passes the injected environment to the child", () => {
  const run = createRunner({ env: { ...process.env, WORKLOG_TEST_TOKEN: "injected" } });
  const result = run(process.execPath, [
    "-e",
    "process.stdout.write(process.env.WORKLOG_TEST_TOKEN ?? 'missing')",
  ]);
  NodeAssert.equal(result.stdout, "injected");
  // The variable must not have leaked into this process.
  NodeAssert.equal(process.env.WORKLOG_TEST_TOKEN, undefined);
});

// --- canonicalRepo ------------------------------------------------------------------------------

NodeTest.test("canonicalRepo collapses every worktree of one repo onto a single key", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const root = tempDir(t);
  const repo = initRepo(NodePath.join(root, "repo"));
  commitFixture(repo, { message: "seed", authorDate: WINDOW_START, files: { "seed.txt": "s\n" } });

  const worktree = NodePath.join(root, "linked");
  git(repo, ["worktree", "add", "-q", "-b", "linked-branch", worktree]);
  const nested = NodePath.join(repo, "deep", "nested", "dir");
  NodeFS.mkdirSync(nested, { recursive: true });

  const run = createRunner({ env: GIT_ENV });
  const fromRepo = canonicalRepo(repo, run);
  const fromWorktree = canonicalRepo(worktree, run);
  // A subdirectory is the regression guard: `git rev-parse --git-common-dir` prints a CWD-relative
  // path, so asking from anywhere but the toplevel would otherwise produce a different key.
  const fromNested = canonicalRepo(nested, run);

  NodeAssert.equal(fromRepo.root, repo);
  NodeAssert.equal(fromNested.root, repo);
  NodeAssert.equal(fromWorktree.root, worktree);
  NodeAssert.equal(fromRepo.key, NodePath.join(repo, ".git"));
  NodeAssert.equal(fromNested.key, fromRepo.key);
  NodeAssert.equal(fromWorktree.key, fromRepo.key);
});

NodeTest.test("canonicalRepo returns null outside a repository", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const root = tempDir(t);
  const run = createRunner({ env: GIT_ENV });
  NodeAssert.equal(canonicalRepo(root, run), null);
  NodeAssert.equal(canonicalRepo(NodePath.join(root, "does-not-exist"), run), null);
});

NodeTest.test("canonicalRepo rejects unusable input without shelling out", () => {
  const run = fakeRunner(() => okReply("/never/used"));
  NodeAssert.equal(canonicalRepo("", run), null);
  NodeAssert.equal(canonicalRepo(undefined, run), null);
  NodeAssert.equal(canonicalRepo(42, run), null);
  NodeAssert.equal(run.calls.length, 0);
});

NodeTest.test("canonicalRepo falls back to <root>/.git when the common-dir lookup fails", () => {
  const run = fakeRunner((cmd, args) =>
    args.includes("--show-toplevel") ? okReply("/tmp/fake-repo\n") : missingBinary(cmd),
  );
  NodeAssert.deepEqual(canonicalRepo("/tmp/fake-repo", run), {
    root: "/tmp/fake-repo",
    commonDir: NodePath.join("/tmp/fake-repo", ".git"),
    key: NodePath.join("/tmp/fake-repo", ".git"),
  });
});

// --- remoteNameWithOwner ------------------------------------------------------------------------

NodeTest.test("remoteNameWithOwner parses every remote URL form git emits", () => {
  const cases = [
    ["git@github.com:radroid/t3code.git\n", "radroid/t3code"],
    ["git@github.com:owner/name", "owner/name"],
    ["https://github.com/owner/name.git\n", "owner/name"],
    ["https://github.com/owner/name", "owner/name"],
    ["https://github.com/owner/name/", "owner/name"],
    ["https://ghp_token:x-oauth-basic@github.com/owner/name.git", "owner/name"],
    ["git://github.com/owner/name.git", "owner/name"],
    ["ssh://git@github.com/owner/name.git", "owner/name"],
    ["ssh://git@github.com:22/owner/name.git", "owner/name"],
    // Only a trailing ".git" is a suffix; the one inside a Pages repo name is part of the name.
    ["git@github.com:owner/name.github.io.git", "owner/name.github.io"],
    // Nested forge namespaces collapse to the last two segments.
    ["https://gitlab.com/group/subgroup/name.git", "subgroup/name"],
    // Local clones and bare paths have no owner/name to report.
    ["file:///Users/someone/repo.git", null],
    ["/Users/someone/repos/owner/name.git", null],
    ["../sibling/repo.git", null],
    ["C:\\repos\\name.git", null],
    ["https://github.com/owner", null],
    ["", null],
  ];
  for (const [url, expected] of cases) {
    const run = fakeRunner(() => okReply(url));
    NodeAssert.equal(remoteNameWithOwner("/repo", run), expected, `url: ${JSON.stringify(url)}`);
  }
});

NodeTest.test("remoteNameWithOwner returns null when there is no origin, and never asks gh", () => {
  const run = fakeRunner(() => ({
    ok: false,
    code: 2,
    stdout: "",
    stderr: "error: No such remote 'origin'",
  }));
  NodeAssert.equal(remoteNameWithOwner("/repo", run), null);
  // `gh repo view` would resolve this fork to its upstream parent — it must never be reached.
  NodeAssert.equal(
    run.calls.some((call) => call.cmd === "gh"),
    false,
  );
});

// --- commitsInWindow ----------------------------------------------------------------------------

NodeTest.test("commitsInWindow returns in-window commits in chronological order", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));
  const commits = windowCommits(repo);

  NodeAssert.deepEqual(subjectsOf(commits), [
    "root: add notes",
    "colleague tweak",
    "add a binary blob",
    "rename the nested file",
    "rebased later",
    "branch work",
    "hoist the directory",
    "rename and extend the notes",
  ]);
  // "before the window" is authored a day early and must not appear.
  NodeAssert.equal(findBySubject(commits, "before the window"), undefined);

  for (const commit of commits) {
    NodeAssert.match(commit.sha, /^[0-9a-f]{40}$/u);
    NodeAssert.ok(commit.sha.startsWith(commit.shortSha));
    NodeAssert.ok(commit.shortSha.length >= 7);
    NodeAssert.equal(commit.author, commit.subject === "colleague tweak" ? OTHER_NAME : RAJ_NAME);
    NodeAssert.ok(Array.isArray(commit.branches) && commit.branches.length > 0);
    NodeAssert.ok(commit.branches.every((branch) => typeof branch === "string" && branch !== ""));
  }
});

NodeTest.test("commitsInWindow keeps a commit whose committer date left the window", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));
  const rebased = findBySubject(windowCommits(repo), "rebased later");
  NodeAssert.ok(rebased, "a rebased commit is filtered by author date, not committer date");
  // Compared as an instant, not a string: git renders a +0000 offset as "Z" or "+00:00" depending
  // on its version, and only the instant is load-bearing.
  NodeAssert.equal(Date.parse(rebased.at), Date.parse("2026-08-10T13:00:00Z"));
});

NodeTest.test("commitsInWindow counts churn, binary files, and renames", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const commits = windowCommits(buildHistory(NodePath.join(tempDir(t), "repo")));

  const root = findBySubject(commits, "root: add notes");
  NodeAssert.deepEqual(
    { files: root.files, insertions: root.insertions, deletions: root.deletions },
    { files: 2, insertions: 4, deletions: 0 },
  );

  // A binary file has real churn git cannot express in lines: it still counts as a touched file,
  // and its "-\t-" row contributes zero rather than NaN.
  const binary = findBySubject(commits, "add a binary blob");
  NodeAssert.deepEqual(
    { files: binary.files, insertions: binary.insertions, deletions: binary.deletions },
    { files: 1, insertions: 0, deletions: 0 },
  );

  // `deep/nest/{f.txt => g.txt}` and `{deep => deepen}/nest/g.txt` are both rename rows; if the
  // parser missed the shape the file count would be 0.
  NodeAssert.equal(findBySubject(commits, "rename the nested file").files, 1);
  NodeAssert.equal(findBySubject(commits, "hoist the directory").files, 1);

  // `notes.md => journal.md` with an edit — the arrow shape must not swallow the churn.
  const renamed = findBySubject(commits, "rename and extend the notes");
  NodeAssert.deepEqual(
    { files: renamed.files, insertions: renamed.insertions, deletions: renamed.deletions },
    { files: 1, insertions: 1, deletions: 0 },
  );
});

NodeTest.test("commitsInWindow attributes commits to their branch", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const commits = windowCommits(buildHistory(NodePath.join(tempDir(t), "repo")));
  NodeAssert.ok(findBySubject(commits, "branch work").branches.includes("feature/window"));
  NodeAssert.ok(findBySubject(commits, "rename and extend the notes").branches.includes("main"));
  // HEAD is decoration, not a branch, and tags are not branches.
  for (const commit of commits) {
    NodeAssert.equal(commit.branches.includes("HEAD"), false);
  }
});

NodeTest.test("commitsInWindow filters by identity across names and both noreply forms", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));

  const bare = windowCommits(repo, ["radroid@users.noreply.github.com"]);
  const numbered = windowCommits(repo, [RAJ_EMAIL]);
  NodeAssert.equal(bare.length, 7);
  NodeAssert.deepEqual(subjectsOf(bare), subjectsOf(numbered));
  NodeAssert.equal(
    bare.some((commit) => commit.subject === "colleague tweak"),
    false,
  );

  // Names match too, and matching is case-insensitive on both sides.
  NodeAssert.deepEqual(subjectsOf(windowCommits(repo, ["SOMEONE ELSE"])), ["colleague tweak"]);
  NodeAssert.deepEqual(subjectsOf(windowCommits(repo, ["Other@Example.COM"])), ["colleague tweak"]);
  NodeAssert.deepEqual(windowCommits(repo, ["nobody@example.com"]), []);
  // An identity list with only junk in it must not silently fall back to "everyone".
  NodeAssert.deepEqual(windowCommits(repo, ["", "   ", null]), []);
});

NodeTest.test("commitsInWindow ignores the refs/t3 checkpoint namespace and the stash", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));
  // No identity filter, so exclusion of the refs is the only thing that can drop these.
  const commits = windowCommits(repo);

  NodeAssert.equal(
    commits.some((commit) => commit.subject.startsWith("t3 checkpoint")),
    false,
    "T3 writes a checkpoint commit per turn; on the real fork they made a single day 49.7 MB of numstat",
  );
  NodeAssert.equal(
    commits.some((commit) => /^(WIP on|On) /u.test(commit.subject)),
    false,
    "a stash entry is not work",
  );
  // The checkpoint ref must not leak into branch attribution either — %S would otherwise report
  // `refs/t3/checkpoints/<base64 thread id>/turn/5` as this commit's branch.
  for (const commit of commits) {
    NodeAssert.equal(
      commit.branches.some(
        (branch) => branch.includes("refs/t3/") || branch.includes("checkpoint"),
      ),
      false,
    );
  }
});

NodeTest.test("commitsInWindow degrades to an empty list instead of throwing", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const notARepo = tempDir(t);
  NodeAssert.deepEqual(windowCommits(notARepo), []);
  NodeAssert.deepEqual(commitsInWindow("", {}, createRunner({ env: GIT_ENV })), []);
  NodeAssert.deepEqual(
    commitsInWindow(
      "/repo",
      {},
      fakeRunner((cmd) => missingBinary(cmd)),
    ),
    [],
  );
});

NodeTest.test("commitsInWindow counts a replayed patch once, not once per copy", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = NodePath.join(tempDir(t), "repo");
  buildReplayedHistory(repo, {
    originalCommitterDate: "2026-08-10T10:00:00Z",
    copyCommitterDate: "2026-08-10T12:00:00Z",
    keepBranch: true,
  });
  // Same author and same subject an hour apart: two real commits, not a replay. Deduping on the
  // subject alone would eat one of these.
  commitFixture(repo, {
    message: "chore: bump the pins",
    authorDate: "2026-08-10T14:00:00Z",
    files: { "pins-a.txt": "1\n" },
  });
  commitFixture(repo, {
    message: "chore: bump the pins",
    authorDate: "2026-08-10T15:00:00Z",
    files: { "pins-b.txt": "2\n" },
  });

  const commits = windowCommits(repo);
  NodeAssert.deepEqual(subjectsOf(commits), [
    "base",
    "upstream moves the base",
    "fix(t3x): the patch that gets replayed",
    "chore: bump the pins",
    "chore: bump the pins",
  ]);
  const replayed = commits.filter(
    (commit) => commit.subject === "fix(t3x): the patch that gets replayed",
  );
  NodeAssert.equal(replayed.length, 1, "the original and its copy are one patch, not two commits");
  // Churn must not double either: it is the same two inserted lines seen twice.
  NodeAssert.deepEqual(
    { files: replayed[0].files, insertions: replayed[0].insertions },
    { files: 1, insertions: 2 },
  );
});

NodeTest.test("commitsInWindow keeps the branch-reachable copy of a replayed patch", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = NodePath.join(tempDir(t), "repo");
  // The tag-only original is COMMITTED later, so `git log` emits it first; without the preference
  // the report would name a SHA that no branch reaches.
  const { copy } = buildReplayedHistory(repo, {
    originalCommitterDate: "2026-08-20T00:00:00Z",
    copyCommitterDate: "2026-08-15T00:00:00Z",
    keepBranch: false,
  });

  const replayed = windowCommits(repo).filter(
    (commit) => commit.subject === "fix(t3x): the patch that gets replayed",
  );
  NodeAssert.equal(replayed.length, 1);
  NodeAssert.equal(replayed[0].sha, copy, "the surviving SHA is the one `git show` still resolves");
  NodeAssert.ok(replayed[0].branches.includes("main"));
});

NodeTest.test("commitsInWindow with an open window returns the whole history", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));
  const all = commitsInWindow(repo, {}, createRunner({ env: GIT_ENV }));
  NodeAssert.equal(all.length, 9);
  NodeAssert.ok(subjectsOf(all).includes("before the window"));
});

// --- mergedPrs ----------------------------------------------------------------------------------

const PR_PAYLOAD = JSON.stringify([
  {
    number: 66,
    title: "fix(t3x): retry the relay notify",
    url: "https://github.com/radroid/t3code/pull/66",
    mergedAt: "2026-08-10T14:00:00Z",
    additions: 120,
    deletions: 8,
    author: { login: "radroid" },
    headRefName: "t3x/relay-retry",
  },
  {
    number: 12,
    title: "merged the day before",
    url: "https://github.com/radroid/t3code/pull/12",
    mergedAt: "2026-08-09T23:59:59Z",
    additions: 1,
    deletions: 1,
    author: { login: "radroid" },
    headRefName: "old",
  },
  {
    number: 99,
    title: "merged exactly at the closing edge",
    url: "https://github.com/radroid/t3code/pull/99",
    mergedAt: WINDOW_END,
    additions: 2,
    deletions: 2,
    author: { login: "radroid" },
    headRefName: "next",
  },
]);

// Any repo with more than one contributor: one PR of the user's, one a colleague merged, one from
// Dependabot, and one whose author GitHub would not name.
const MIXED_PR_PAYLOAD = JSON.stringify([
  {
    number: 66,
    title: "fix(t3x): retry the relay notify",
    mergedAt: "2026-08-10T14:00:00Z",
    additions: 120,
    deletions: 8,
    author: { login: "radroid" },
  },
  {
    number: 67,
    title: "a colleague's big refactor",
    mergedAt: "2026-08-10T15:00:00Z",
    additions: 900,
    deletions: 400,
    author: { login: "SomeoneElse" },
  },
  {
    number: 68,
    title: "chore(deps): bump vite",
    mergedAt: "2026-08-10T16:00:00Z",
    additions: 4,
    deletions: 4,
    author: { login: "dependabot[bot]" },
  },
  { number: 69, title: "author deleted their account", mergedAt: "2026-08-10T17:00:00Z" },
]);

NodeTest.test("mergedPrs counts only the pull requests the user merged", () => {
  const window = { start: WINDOW_START, end: WINDOW_END };
  const identityForms = [
    ["@radroid"], // what `githubLoginIdentity` seeds
    ["@RadRoid"], // logins are case-insensitive
    ["radroid"], // a bare login typed by hand
    [RAJ_EMAIL], // a noreply address already encodes the login
    ["radroid@users.noreply.github.com"],
    ["Raj D", RAJ_EMAIL], // the real registry shape: a name that is not a login, plus an email
  ];
  for (const identities of identityForms) {
    const label = JSON.stringify(identities);
    const { prs, warnings } = mergedPrs(
      "radroid/t3code",
      { ...window, identities },
      fakeRunner(() => okReply(MIXED_PR_PAYLOAD)),
    );
    NodeAssert.deepEqual(
      prs.map((pr) => pr.number),
      [66],
      label,
    );
    NodeAssert.deepEqual(warnings, [], label);
  }
});

NodeTest.test("mergedPrs keeps unattributable pull requests but says they may not be yours", () => {
  const window = { start: WINDOW_START, end: WINDOW_END };
  // None of these carries a login: no identities at all, and identities that are only a name or a
  // real email address.
  for (const identities of [undefined, [], ["Raj D"], ["raj9dholakia@gmail.com"], ["", null]]) {
    const label = JSON.stringify(identities ?? null);
    const { prs, warnings } = mergedPrs(
      "radroid/t3code",
      { ...window, identities },
      fakeRunner(() => okReply(MIXED_PR_PAYLOAD)),
    );
    NodeAssert.deepEqual(
      prs.map((pr) => pr.number),
      [66, 67, 68, 69],
      label,
    );
    NodeAssert.equal(warnings.length, 1, label);
    NodeAssert.match(warnings[0], /could not be attributed/u, label);
    NodeAssert.match(warnings[0], /radroid\/t3code/u, label);
  }
});

NodeTest.test("mergedPrs adds no attribution caveat when the window held no pull requests", () => {
  const { prs, warnings } = mergedPrs(
    "radroid/t3code",
    { start: WINDOW_START, end: WINDOW_END },
    fakeRunner(() => okReply("[]")),
  );
  // Nothing to caveat: an empty list cannot include anyone else's work.
  NodeAssert.deepEqual(prs, []);
  NodeAssert.deepEqual(warnings, []);
});

NodeTest.test(
  "githubLoginIdentity reads the signed-in login in the form identities expects",
  () => {
    const run = fakeRunner(() => okReply("radroid\n"));
    NodeAssert.equal(githubLoginIdentity(run), "@radroid");
    NodeAssert.deepEqual(run.calls, [
      { cmd: "gh", args: ["api", "user", "-q", ".login"], options: {} },
    ]);
  },
);

NodeTest.test("githubLoginIdentity returns null rather than a junk identity", () => {
  const cases = [
    fakeRunner((cmd) => missingBinary(cmd)),
    fakeRunner(() => ({ ok: false, code: 4, stdout: "", stderr: "gh: not authenticated" })),
    fakeRunner(() => okReply("")),
    fakeRunner(() => okReply("\n")),
    // An error page or a `gh` that answered with something that is not a login.
    fakeRunner(() => okReply("<html>502 Bad Gateway</html>")),
    fakeRunner(() => okReply("not a login\n")),
  ];
  for (const run of cases) NodeAssert.equal(githubLoginIdentity(run), null);
});

NodeTest.test("mergedPrs filters precisely on mergedAt and scopes gh to the fork", () => {
  const run = fakeRunner(() => okReply(PR_PAYLOAD));
  const { prs, warnings } = mergedPrs(
    "radroid/t3code",
    { start: WINDOW_START, end: WINDOW_END },
    run,
  );

  // No identity carries a login here, so the list is unattributed and says so rather than
  // quietly passing off whatever `gh` returned as this user's work.
  NodeAssert.equal(warnings.length, 1);
  NodeAssert.match(warnings[0], /could not be attributed/u);
  NodeAssert.equal(
    prs.length,
    1,
    "the day-before PR and the half-open upper edge are both excluded",
  );
  NodeAssert.deepEqual(prs[0], {
    number: 66,
    title: "fix(t3x): retry the relay notify",
    url: "https://github.com/radroid/t3code/pull/66",
    mergedAt: "2026-08-10T14:00:00Z",
    additions: 120,
    deletions: 8,
    author: "radroid",
    headRefName: "t3x/relay-retry",
  });

  const [call] = run.calls;
  NodeAssert.equal(call.cmd, "gh");
  // Without --repo, gh resolves this fork to pingdotgg/t3code and reports the upstream's PRs.
  NodeAssert.equal(call.args[call.args.indexOf("--repo") + 1], "radroid/t3code");
  NodeAssert.ok(call.args.includes("--state") && call.args.includes("merged"));
  const search = call.args[call.args.indexOf("--search") + 1];
  NodeAssert.match(search, /merged:>=\d{4}-\d{2}-\d{2} merged:<=\d{4}-\d{2}-\d{2}/u);
  NodeAssert.equal(
    run.calls.some((entry) => entry.args[0] === "repo"),
    false,
  );
});

NodeTest.test("mergedPrs sorts by merge time", () => {
  const payload = JSON.stringify([
    { number: 3, mergedAt: "2026-08-10T18:00:00Z", author: { login: "a" } },
    { number: 1, mergedAt: "2026-08-10T06:00:00Z", author: { login: "a" } },
    { number: 2, mergedAt: "2026-08-10T12:00:00Z", author: { login: "a" } },
  ]);
  const { prs } = mergedPrs(
    "radroid/t3code",
    { start: WINDOW_START, end: WINDOW_END },
    fakeRunner(() => okReply(payload)),
  );
  NodeAssert.deepEqual(
    prs.map((pr) => pr.number),
    [1, 2, 3],
  );
});

NodeTest.test("mergedPrs degrades to a warning for every gh failure mode", () => {
  const window = { start: WINDOW_START, end: WINDOW_END };
  const scenarios = [
    ["missing binary", fakeRunner((cmd) => missingBinary(cmd)), /gh unavailable|ENOENT/u],
    [
      "unauthenticated",
      fakeRunner(() => ({
        ok: false,
        code: 4,
        stdout: "",
        stderr:
          "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.",
      })),
      /GH_TOKEN/u,
    ],
    [
      "network failure",
      fakeRunner(() => ({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "dial tcp: lookup api.github.com: no such host",
      })),
      /no such host/u,
    ],
    ["invalid json", fakeRunner(() => okReply("<html>502 Bad Gateway</html>")), /unparseable/u],
    ["truncated json", fakeRunner(() => okReply('[{"number": 1,')), /unparseable/u],
    ["unexpected shape", fakeRunner(() => okReply('{"message":"Not Found"}')), /unexpected shape/u],
    ["empty stdout", fakeRunner(() => okReply("")), /unparseable/u],
  ];
  for (const [label, run, pattern] of scenarios) {
    const result = mergedPrs("radroid/t3code", window, run);
    NodeAssert.deepEqual(result.prs, [], label);
    NodeAssert.equal(result.warnings.length, 1, label);
    NodeAssert.match(result.warnings[0], pattern, label);
    NodeAssert.match(result.warnings[0], /radroid\/t3code/u, label);
  }
});

NodeTest.test("mergedPrs skips the lookup entirely when there is no GitHub remote", () => {
  for (const value of [null, undefined, "", "   "]) {
    const run = fakeRunner(() => okReply("[]"));
    const result = mergedPrs(value, { start: WINDOW_START, end: WINDOW_END }, run);
    NodeAssert.deepEqual(result.prs, []);
    NodeAssert.equal(result.warnings.length, 1);
    NodeAssert.equal(run.calls.length, 0);
  }
});

NodeTest.test("mergedPrs tolerates malformed rows inside a valid array", () => {
  const payload = JSON.stringify([
    null,
    "not an object",
    { number: 7, mergedAt: "not a date" },
    { number: 8 },
    {
      number: 9,
      mergedAt: "2026-08-10T10:00:00Z",
      title: null,
      additions: "many",
      author: "radroid",
    },
  ]);
  const { prs, warnings } = mergedPrs(
    "radroid/t3code",
    { start: WINDOW_START, end: WINDOW_END },
    fakeRunner(() => okReply(payload)),
  );
  // Unattributed again: no identity here carries a login.
  NodeAssert.equal(warnings.length, 1);
  NodeAssert.match(warnings[0], /could not be attributed/u);
  NodeAssert.equal(prs.length, 1);
  // A row with an author string rather than the {login} object still yields a usable record.
  NodeAssert.deepEqual(prs[0], {
    number: 9,
    title: "",
    url: "",
    mergedAt: "2026-08-10T10:00:00Z",
    additions: 0,
    deletions: 0,
    author: null,
    headRefName: null,
  });
});

NodeTest.test("mergedPrs with an open window omits the search qualifier", () => {
  const run = fakeRunner(() => okReply("[]"));
  const { prs, warnings } = mergedPrs("radroid/t3code", {}, run);
  NodeAssert.deepEqual(prs, []);
  NodeAssert.deepEqual(warnings, []);
  NodeAssert.equal(run.calls[0].args.includes("--search"), false);
});

// --- collectGit ---------------------------------------------------------------------------------

NodeTest.test("collectGit visits each repo once no matter how many worktrees are listed", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const root = tempDir(t);
  const repo = buildHistory(NodePath.join(root, "repo"));
  git(repo, ["remote", "add", "origin", "git@github.com:radroid/t3code.git"]);
  const worktree = NodePath.join(root, "linked");
  git(repo, ["worktree", "add", "-q", "-b", "linked-branch", worktree]);
  const nested = NodePath.join(repo, "deepen", "nest");
  const notARepo = NodePath.join(root, "plain");
  NodeFS.mkdirSync(notARepo, { recursive: true });

  // Real git, faked gh: the suite must never reach the network. The payload is the mixed one so
  // that the identity list has to reach `gh pr list` too — commits and PRs are one number each in
  // the report, and they have to be counted to the same standard.
  const realRun = createRunner({ env: GIT_ENV });
  const run = fakeRunner((cmd, args, options) =>
    cmd === "gh" ? okReply(MIXED_PR_PAYLOAD) : realRun(cmd, args, options),
  );

  const result = collectGit(
    [repo, worktree, nested, notARepo, "", null],
    { start: WINDOW_START, end: WINDOW_END, identities: [RAJ_EMAIL] },
    { run },
  );

  NodeAssert.equal(
    result.repos.length,
    1,
    "three checkouts of one repo collapse to a single entry",
  );
  const [entry] = result.repos;
  NodeAssert.equal(entry.root, repo);
  NodeAssert.equal(entry.key, NodePath.join(repo, ".git"));
  NodeAssert.equal(entry.nameWithOwner, "radroid/t3code");
  NodeAssert.equal(entry.commits.length, 7);
  // Four merged PRs in the window, one of them this user's: a colleague's, Dependabot's, and an
  // unattributed one are not this user's work.
  NodeAssert.deepEqual(
    entry.mergedPrs.map((pr) => pr.number),
    [66],
  );
  NodeAssert.deepEqual(entry.warnings, []);

  // Three unusable inputs, three warnings, and none of them abort the collection.
  NodeAssert.equal(result.warnings.length, 3);
  NodeAssert.ok(result.warnings.every((warning) => /Not a git repository/u.test(warning)));

  // gh is asked once — once per repo, not once per worktree — and never for repo metadata.
  const ghCalls = run.calls.filter((call) => call.cmd === "gh");
  NodeAssert.equal(ghCalls.length, 1);
  NodeAssert.equal(
    ghCalls.some((call) => call.args[0] === "repo"),
    false,
  );
});

NodeTest.test("collectGit records a warning instead of failing when the remote is missing", (t) => {
  if (!GIT_AVAILABLE) return t.skip("git is not available");
  const repo = buildHistory(NodePath.join(tempDir(t), "repo"));
  const realRun = createRunner({ env: GIT_ENV });
  const run = fakeRunner((cmd, args, options) =>
    cmd === "gh" ? missingBinary(cmd) : realRun(cmd, args, options),
  );

  const result = collectGit(repo, { start: WINDOW_START, end: WINDOW_END }, { run });
  const [entry] = result.repos;
  NodeAssert.equal(entry.nameWithOwner, null);
  NodeAssert.deepEqual(entry.mergedPrs, []);
  NodeAssert.equal(entry.commits.length, 8, "commits still collected without a remote");
  NodeAssert.equal(
    entry.warnings.length,
    2,
    "one for the absent origin, one for the skipped PR lookup",
  );
  NodeAssert.ok(entry.warnings.some((warning) => /origin remote/u.test(warning)));
  // With no remote resolved, gh is never invoked at all.
  NodeAssert.equal(
    run.calls.some((call) => call.cmd === "gh"),
    false,
  );
});

NodeTest.test("collectGit returns an empty result for empty input", () => {
  const run = fakeRunner(() => okReply(""));
  NodeAssert.deepEqual(collectGit([], {}, { run }), { repos: [], warnings: [] });
  NodeAssert.deepEqual(collectGit(null, {}, { run }), { repos: [], warnings: [] });
  NodeAssert.equal(run.calls.length, 0);
});
