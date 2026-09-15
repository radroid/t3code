import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const syncScript = NodePath.join(import.meta.dirname, "sync-upstream.sh");

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commit(cwd: string, message: string) {
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", message);
}

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "coil-sync-workflows-"));
  const upstream = NodePath.join(root, "upstream");
  const fork = NodePath.join(root, "fork");
  const workflow = NodePath.join(upstream, ".github", "workflows", "ci.yml");

  NodeFS.mkdirSync(NodePath.dirname(workflow), { recursive: true });
  NodeFS.writeFileSync(workflow, "name: upstream-ci-v1\n");
  NodeFS.writeFileSync(NodePath.join(upstream, "shared.txt"), "base\n");
  git(upstream, "init", "--quiet", "--initial-branch=main");
  git(upstream, "config", "user.name", "test");
  git(upstream, "config", "user.email", "test@example.com");
  commit(upstream, "base");

  git(root, "clone", "--quiet", upstream, fork);
  git(fork, "config", "user.name", "test");
  git(fork, "config", "user.email", "test@example.com");
  git(fork, "remote", "rename", "origin", "upstream");
  NodeFS.rmSync(NodePath.join(fork, ".github", "workflows", "ci.yml"));
  commit(fork, "retire upstream ci");

  return { root, upstream, fork, workflow };
}

function runSync(fork: string) {
  return NodeChildProcess.spawnSync(syncScript, {
    cwd: fork,
    encoding: "utf8",
    env: {
      ...process.env,
      SKIP_VERIFY: "1",
      STATUS_FILE: NodePath.join(fork, "sync-status.json"),
    },
  });
}

it("keeps a retired workflow deleted when upstream modifies it", () => {
  const fixture = makeFixture();
  try {
    NodeFS.writeFileSync(fixture.workflow, "name: upstream-ci-v2\n");
    NodeFS.writeFileSync(NodePath.join(fixture.upstream, "upstream.txt"), "new\n");
    commit(fixture.upstream, "modify retired workflow");

    const result = runSync(fixture.fork);

    assert.strictEqual(result.status, 0, result.stderr);
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(fixture.fork, ".github", "workflows", "ci.yml")),
    );
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(fixture.fork, "upstream.txt"), "utf8"),
      "new\n",
    );
    assert.lengthOf(
      git(fixture.fork, "rev-list", "--parents", "-n1", "HEAD").trim().split(/\s+/),
      3,
    );
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("still aborts and restores the fork for a non-workflow conflict", () => {
  const fixture = makeFixture();
  try {
    NodeFS.writeFileSync(fixture.workflow, "name: upstream-ci-v2\n");
    NodeFS.writeFileSync(NodePath.join(fixture.upstream, "shared.txt"), "upstream\n");
    commit(fixture.upstream, "modify workflow and shared file");

    NodeFS.writeFileSync(NodePath.join(fixture.fork, "shared.txt"), "fork\n");
    commit(fixture.fork, "modify shared file");
    const head = git(fixture.fork, "rev-parse", "HEAD").trim();

    const result = runSync(fixture.fork);

    assert.strictEqual(result.status, 20, result.stderr);
    assert.strictEqual(git(fixture.fork, "rev-parse", "HEAD").trim(), head);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(fixture.fork, "shared.txt"), "utf8"),
      "fork\n",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.fork, ".git", "MERGE_HEAD")));
    assert.strictEqual(git(fixture.fork, "ls-files", "--unmerged"), "");
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});
