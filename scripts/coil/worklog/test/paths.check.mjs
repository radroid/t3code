// Tests for lib/paths.mjs. Everything runs against a throwaway HOME under os.tmpdir(); the
// user's real ~/.t3 and ~/.claude are never touched.

import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import {
  claudeProjectsDir,
  defaultWorklogRoot,
  expandHome,
  homeDir,
  isUnder,
  repoRelative,
  safeKey,
  slugify,
  t3BaseDirs,
  t3StateDbPath,
  t3WorktreesRoot,
  tildify,
  worklogPaths,
} from "../lib/paths.mjs";

const MANAGED_ENV = ["HOME", "WORKLOG_T3_BASE_DIRS", "WORKLOG_CLAUDE_PROJECTS", "WORKLOG_ROOT"];

let sandbox = "";
let fakeHome = "";
const savedEnv = new Map();

NodeTest.before(() => {
  for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key]);
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  fakeHome = NodePath.join(sandbox, "home");
  NodeFS.mkdirSync(fakeHome, { recursive: true });
});

NodeTest.after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (sandbox !== "") NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

NodeTest.beforeEach(() => {
  process.env.HOME = fakeHome;
  delete process.env.WORKLOG_T3_BASE_DIRS;
  delete process.env.WORKLOG_CLAUDE_PROJECTS;
  delete process.env.WORKLOG_ROOT;
});

/** Makes a directory under the fake home and returns its absolute path. */
function mkHomeDir(...segments) {
  const dir = NodePath.join(fakeHome, ...segments);
  NodeFS.mkdirSync(dir, { recursive: true });
  return dir;
}

NodeTest.test("homeDir honours HOME and normalises it", () => {
  NodeAssert.equal(homeDir(), fakeHome);

  process.env.HOME = `${fakeHome}/nested/..`;
  NodeAssert.equal(homeDir(), fakeHome);

  process.env.HOME = `  ${fakeHome}  `;
  NodeAssert.equal(homeDir(), fakeHome);
});

NodeTest.test("homeDir falls back to the OS home when HOME is unset or blank", () => {
  delete process.env.HOME;
  NodeAssert.equal(homeDir(), NodeOS.homedir());
  NodeAssert.ok(NodePath.isAbsolute(homeDir()));

  process.env.HOME = "   ";
  NodeAssert.equal(homeDir(), NodeOS.homedir());
});

NodeTest.test("t3BaseDirs returns only the state directories that exist, userdata first", () => {
  NodeAssert.deepEqual(t3BaseDirs(), []);

  const dev = mkHomeDir(".t3", "dev");
  NodeAssert.deepEqual(t3BaseDirs(), [dev]);

  const userdata = mkHomeDir(".t3", "userdata");
  NodeAssert.deepEqual(t3BaseDirs(), [userdata, dev]);

  NodeFS.rmSync(dev, { recursive: true, force: true });
  NodeAssert.deepEqual(t3BaseDirs(), [userdata]);
  NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
});

NodeTest.test("t3BaseDirs ignores a path that exists but is not a directory", () => {
  mkHomeDir(".t3");
  NodeFS.writeFileSync(NodePath.join(fakeHome, ".t3", "userdata"), "not a directory");
  NodeAssert.deepEqual(t3BaseDirs(), []);
  NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
});

NodeTest.test(
  "WORKLOG_T3_BASE_DIRS overrides, splits on ':', expands ~, dedupes, drops missing",
  () => {
    const first = mkHomeDir("state-a");
    const second = mkHomeDir("state-b");
    const missing = NodePath.join(sandbox, "gone");

    process.env.WORKLOG_T3_BASE_DIRS = ["~/state-b", first, missing, second, "~/state-a"].join(":");
    NodeAssert.deepEqual(t3BaseDirs(), [second, first]);

    // A blank override is not an empty allow-list: it falls back to the default locations.
    const userdata = mkHomeDir(".t3", "userdata");
    process.env.WORKLOG_T3_BASE_DIRS = "  ";
    NodeAssert.deepEqual(t3BaseDirs(), [userdata]);

    NodeFS.rmSync(first, { recursive: true, force: true });
    NodeFS.rmSync(second, { recursive: true, force: true });
    NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
  },
);

NodeTest.test("t3StateDbPath names the sqlite file inside a base dir", () => {
  NodeAssert.equal(t3StateDbPath("/tmp/base"), NodePath.join("/tmp/base", "state.sqlite"));
  NodeAssert.equal(
    t3StateDbPath("~/.t3/userdata"),
    NodePath.join(fakeHome, ".t3/userdata/state.sqlite"),
  );
});

NodeTest.test("t3WorktreesRoot follows HOME", () => {
  NodeAssert.equal(t3WorktreesRoot(), NodePath.join(fakeHome, ".t3", "worktrees"));
});

NodeTest.test("claudeProjectsDir defaults under HOME and honours its override", () => {
  NodeAssert.equal(claudeProjectsDir(), NodePath.join(fakeHome, ".claude", "projects"));

  process.env.WORKLOG_CLAUDE_PROJECTS = "~/elsewhere/projects";
  NodeAssert.equal(claudeProjectsDir(), NodePath.join(fakeHome, "elsewhere", "projects"));

  process.env.WORKLOG_CLAUDE_PROJECTS = "";
  NodeAssert.equal(claudeProjectsDir(), NodePath.join(fakeHome, ".claude", "projects"));
});

NodeTest.test("defaultWorklogRoot defaults to ~/Developer/worklog and honours WORKLOG_ROOT", () => {
  NodeAssert.equal(defaultWorklogRoot(), NodePath.join(fakeHome, "Developer", "worklog"));

  process.env.WORKLOG_ROOT = "~/logs";
  NodeAssert.equal(defaultWorklogRoot(), NodePath.join(fakeHome, "logs"));
});

NodeTest.test("worklogPaths lays out the repo exactly as the design specifies", () => {
  const root = NodePath.join(sandbox, "worklog-repo");
  NodeAssert.deepEqual(worklogPaths(root), {
    root,
    config: `${root}/config`,
    projectsYaml: `${root}/config/projects.yaml`,
    redactionYaml: `${root}/config/redaction.yaml`,
    days: `${root}/days`,
    ranges: `${root}/ranges`,
    extracts: `${root}/extracts`,
    tmp: `${root}/.worklog-tmp`,
    slices: `${root}/.worklog-tmp/slices`,
    bundles: `${root}/.worklog-tmp/bundles`,
  });

  for (const value of Object.values(worklogPaths(root))) {
    NodeAssert.ok(NodePath.isAbsolute(value), `${value} should be absolute`);
  }
});

NodeTest.test(
  "worklogPaths falls back to the default root and resolves relative or ~ roots",
  () => {
    process.env.WORKLOG_ROOT = NodePath.join(sandbox, "configured");
    NodeAssert.equal(worklogPaths().root, NodePath.join(sandbox, "configured"));
    NodeAssert.equal(worklogPaths("").root, NodePath.join(sandbox, "configured"));

    NodeAssert.equal(worklogPaths("~/logs").root, NodePath.join(fakeHome, "logs"));
    NodeAssert.equal(worklogPaths("./relative/root").root, NodePath.resolve("relative/root"));
  },
);

NodeTest.test("expandHome expands a bare ~, resolves, and refuses to guess ~user", () => {
  NodeAssert.equal(expandHome("~"), fakeHome);
  NodeAssert.equal(expandHome("~/a/b"), NodePath.join(fakeHome, "a", "b"));
  NodeAssert.equal(expandHome("/a/b/../c"), "/a/c");
  NodeAssert.equal(expandHome("  /a/b  "), "/a/b");
  NodeAssert.equal(expandHome("~someone/x"), NodePath.resolve("~someone/x"));
  NodeAssert.equal(expandHome(""), "");
  NodeAssert.equal(expandHome("   "), "");
  NodeAssert.equal(expandHome(null), "");
  NodeAssert.equal(expandHome(undefined), "");
  NodeAssert.equal(expandHome(42), "");
});

NodeTest.test("tildify hides the home prefix without matching a sibling directory", () => {
  NodeAssert.equal(tildify(fakeHome), "~");
  NodeAssert.equal(tildify(`${fakeHome}/`), "~");
  NodeAssert.equal(tildify(NodePath.join(fakeHome, "Developer", "t3code")), "~/Developer/t3code");
  NodeAssert.equal(tildify("~/Developer"), "~/Developer");

  // The prefix trap: "<home>2" merely starts with the home string.
  NodeAssert.equal(tildify(`${fakeHome}2/notes`), `${fakeHome}2/notes`);

  NodeAssert.equal(tildify("/opt/tools"), "/opt/tools");
  NodeAssert.equal(tildify("relative/path"), "relative/path");
  NodeAssert.equal(tildify(""), "");
  NodeAssert.equal(tildify(null), "");
});

NodeTest.test("safeKey folds to a filesystem-safe token", () => {
  NodeAssert.equal(safeKey("Hello, World!"), "hello-world");
  NodeAssert.equal(safeKey("T3 Code (fork)"), "t3-code-fork");
  NodeAssert.equal(safeKey("v1.2.3_final"), "v1.2.3_final");
  // The accent must fold to its base letter, not to a separator: "resume", never "re-sume".
  NodeAssert.equal(safeKey("Résumé"), "resume");
  NodeAssert.equal(safeKey("Café Ideas"), "cafe-ideas");
  NodeAssert.equal(safeKey("Zürich Möbel"), "zurich-mobel");
  NodeAssert.equal(safeKey("--already--collapsed--"), "already-collapsed");
  NodeAssert.equal(safeKey("/Users/x/Developer/t3code"), "users-x-developer-t3code");
  NodeAssert.equal(safeKey(42), "42");
});

NodeTest.test("safeKey never returns an empty or over-long key", () => {
  NodeAssert.equal(safeKey(""), "unknown");
  NodeAssert.equal(safeKey("   "), "unknown");
  NodeAssert.equal(safeKey("!!! ???"), "unknown");
  NodeAssert.equal(safeKey(null), "unknown");
  NodeAssert.equal(safeKey(undefined), "unknown");

  NodeAssert.equal(safeKey("a".repeat(200)), "a".repeat(80));
  // The 80-char cut lands on the separator, which must not survive as a trailing dash.
  NodeAssert.equal(safeKey(`${"a".repeat(79)} !! b`), "a".repeat(79));
});

NodeTest.test("slugify treats dots as separators too", () => {
  NodeAssert.equal(slugify("v1.2.3_final"), "v1-2-3_final");
  NodeAssert.equal(slugify("node.js Playground"), "node-js-playground");
  NodeAssert.equal(slugify("t3code"), "t3code");
  NodeAssert.equal(slugify("..."), "unknown");
  NodeAssert.equal(slugify("T3 Code (fork)"), safeKey("T3 Code (fork)"));
});

NodeTest.test("isUnder does segment containment, not string prefixing", () => {
  NodeAssert.equal(isUnder("/a/b/c", "/a/b"), true);
  NodeAssert.equal(isUnder("/a/b/c/d/e", "/a/b"), true);
  NodeAssert.equal(isUnder("/a/bc", "/a/b"), false);
  NodeAssert.equal(isUnder("/a/b-extra/x", "/a/b"), false);
  NodeAssert.equal(isUnder("/a/b", "/a/b"), true, "a path is under itself");
  NodeAssert.equal(isUnder("/a", "/a/b"), false);
  NodeAssert.equal(isUnder("/x/y", "/a/b"), false);
});

NodeTest.test("isUnder normalises both sides before comparing", () => {
  NodeAssert.equal(isUnder("/a/b/", "/a"), true);
  NodeAssert.equal(isUnder("/a/b/./c", "/a//b"), true);
  NodeAssert.equal(isUnder("/a/b/../c", "/a/b"), false);
  NodeAssert.equal(isUnder("~/.t3/worktrees/t3code-1", "~/.t3/worktrees"), true);
  NodeAssert.equal(isUnder(NodePath.join(fakeHome, ".t3/worktrees/x"), t3WorktreesRoot()), true);

  // "..foo" is a real directory name, not an escape.
  NodeAssert.equal(isUnder("/a/..foo", "/a"), true);

  NodeAssert.equal(isUnder("", "/a"), false);
  NodeAssert.equal(isUnder("/a", ""), false);
  NodeAssert.equal(isUnder(null, "/a"), false);
});

NodeTest.test("repoRelative falls back to the basename outside the root", () => {
  NodeAssert.equal(repoRelative("/repo", "/repo/src/index.ts"), "src/index.ts");
  NodeAssert.equal(repoRelative("/repo/", "/repo/a/b.txt"), "a/b.txt");
  NodeAssert.equal(repoRelative("/repo", "/other/place/file.ts"), "file.ts");
  NodeAssert.equal(repoRelative("/repo", "/repo"), "repo", "the root itself reads as its own name");
  NodeAssert.equal(repoRelative("/repo", "/repo-sibling/x.ts"), "x.ts");
  NodeAssert.equal(repoRelative("~/code", "~/code/lib/a.mjs"), "lib/a.mjs");
  NodeAssert.equal(repoRelative("", "/repo/src/index.ts"), "index.ts");
  NodeAssert.equal(repoRelative("/repo", ""), "");
  NodeAssert.equal(repoRelative("/repo", null), "");
});
