// @effect-diagnostics nodeBuiltinImport:off - Builds disposable on-disk git repos for the range reader.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readUpstreamRange, renderUpstreamChanges } from "./upstream-changes.ts";

const render = (...subjects: ReadonlyArray<string>) =>
  renderUpstreamChanges({
    commits: subjects.map((subject, index) => ({ sha: `${index}`.padStart(40, "a"), subject })),
    base: "base",
    head: "head",
  });

describe("renderUpstreamChanges", () => {
  it("keeps what a user would notice and drops dev-only work", () => {
    const notes = render(
      "test(web): browser tests use the disposable helper (#3)",
      "feat(scheduled-tasks): event filters for webhook deliveries (#1)",
      "ci(release): Windows arm64 job is 50% faster (#4)",
      "fix(web,mobile): limits bars show the pace mark (#2)",
      "Bump the runner image",
    );

    assert.include(
      notes,
      "3 user-facing changes from upstream T3 Code, out of 5 upstream commits.",
    );
    assert.include(notes, "- **Scheduled tasks:** Event filters for webhook deliveries ([#1](");
    assert.include(notes, "- **Web, Mobile:** Limits bars show the pace mark ([#2](");
    assert.include(notes, "### Other\n\n- Bump the runner image");
    assert.notInclude(notes, "browser tests");
    assert.notInclude(notes, "arm64");
    assert.isBelow(notes.indexOf("### New"), notes.indexOf("### Fixed and improved"));
  });

  // The body is posted on the fork. A live `@name` notifies an upstream contributor, a bare `#12`
  // links the fork's own issue, and a link to an upstream PR adds a timeline event there.
  it("never mentions anyone or links an upstream PR", () => {
    const notes = render("fix(deps): revert @effect/vitest bump from #12 for @someone (#99)");

    assert.include(notes, "`@effect/vitest`");
    assert.include(notes, "`@someone`");
    assert.include(notes, "`#12`");
    assert.include(notes, "[#99](https://github.com/pingdotgg/t3code/commit/");
    assert.notInclude(notes, "/pull/");
  });

  it("says so when an update changes nothing a user would see", () => {
    const notes = render("test(server): steer test no longer hangs (#1)", "ci: cache pnpm (#2)");

    assert.include(notes, "None of the 2 upstream commits in this update change the app");
    assert.notInclude(notes, "###");
  });

  it("stays under GitHub's PR body limit on a huge range and counts what it left out", () => {
    const subjects = Array.from(
      { length: 2_000 },
      (_, index) => `fix(web): a long enough description of change number ${index} (#${index})`,
    );
    const notes = render(...subjects);
    const shown = notes.split("\n").filter((line) => line.startsWith("- ")).length;

    assert.isBelow(notes.length, 65_536);
    assert.include(notes, `…and ${2_000 - shown} more.`);
  });
});

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// One file per commit, so merging the two lines of history never conflicts.
function commit(cwd: string, message: string) {
  NodeFS.writeFileSync(NodePath.join(cwd, `${message.replace(/\W+/gu, "-")}.txt`), message);
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", message);
}

describe("readUpstreamRange", () => {
  // A resolver sync lands through GitHub's "Merge pull request" commit, whose parents are the old
  // main and the PR branch, not upstream. The range must still be upstream's commits alone.
  it("lists only upstream's new commits, through a PR merge and fork commits", () => {
    const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "coil-upstream-changes-"));
    git(repo, "init", "--quiet", "--initial-branch=upstream");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    commit(repo, "feat: already absorbed");
    git(repo, "branch", "main");

    commit(repo, "feat: first new upstream change");
    commit(repo, "fix: second new upstream change");

    git(repo, "switch", "--quiet", "main");
    commit(repo, "feat(coil): fork-only change");
    git(repo, "switch", "--quiet", "-c", "sync");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "chore(coil): merge upstream", "upstream");
    commit(repo, "fix(coil): fix-up after the merge");
    git(repo, "switch", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge pull request #7", "sync");

    const range = readUpstreamRange({ since: "main~1", upstream: "upstream", cwd: repo });

    assert.deepStrictEqual(
      range.commits.map((change) => change.subject),
      ["feat: first new upstream change", "fix: second new upstream change"],
    );
    assert.strictEqual(range.head, git(repo, "rev-parse", "upstream"));
  });
});
