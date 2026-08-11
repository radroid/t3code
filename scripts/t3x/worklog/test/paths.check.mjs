// Tests for lib/paths.mjs. Everything runs against a throwaway HOME under os.tmpdir(); the
// user's real ~/.t3 and ~/.claude are never touched.

import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test, { after, before, beforeEach } from "node:test";

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

before(() => {
  for (const key of MANAGED_ENV) savedEnv.set(key, process.env[key]);
  sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worklog-"));
  fakeHome = NodePath.join(sandbox, "home");
  NodeFS.mkdirSync(fakeHome, { recursive: true });
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (sandbox !== "") NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
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

test("homeDir honours HOME and normalises it", () => {
  assert.equal(homeDir(), fakeHome);

  process.env.HOME = `${fakeHome}/nested/..`;
  assert.equal(homeDir(), fakeHome);

  process.env.HOME = `  ${fakeHome}  `;
  assert.equal(homeDir(), fakeHome);
});

test("homeDir falls back to the OS home when HOME is unset or blank", () => {
  delete process.env.HOME;
  assert.equal(homeDir(), NodeOS.homedir());
  assert.ok(NodePath.isAbsolute(homeDir()));

  process.env.HOME = "   ";
  assert.equal(homeDir(), NodeOS.homedir());
});

test("t3BaseDirs returns only the state directories that exist, userdata first", () => {
  assert.deepEqual(t3BaseDirs(), []);

  const dev = mkHomeDir(".t3", "dev");
  assert.deepEqual(t3BaseDirs(), [dev]);

  const userdata = mkHomeDir(".t3", "userdata");
  assert.deepEqual(t3BaseDirs(), [userdata, dev]);

  NodeFS.rmSync(dev, { recursive: true, force: true });
  assert.deepEqual(t3BaseDirs(), [userdata]);
  NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
});

test("t3BaseDirs ignores a path that exists but is not a directory", () => {
  mkHomeDir(".t3");
  NodeFS.writeFileSync(NodePath.join(fakeHome, ".t3", "userdata"), "not a directory");
  assert.deepEqual(t3BaseDirs(), []);
  NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
});

test("WORKLOG_T3_BASE_DIRS overrides, splits on ':', expands ~, dedupes, drops missing", () => {
  const first = mkHomeDir("state-a");
  const second = mkHomeDir("state-b");
  const missing = NodePath.join(sandbox, "gone");

  process.env.WORKLOG_T3_BASE_DIRS = ["~/state-b", first, missing, second, "~/state-a"].join(":");
  assert.deepEqual(t3BaseDirs(), [second, first]);

  // A blank override is not an empty allow-list: it falls back to the default locations.
  const userdata = mkHomeDir(".t3", "userdata");
  process.env.WORKLOG_T3_BASE_DIRS = "  ";
  assert.deepEqual(t3BaseDirs(), [userdata]);

  NodeFS.rmSync(first, { recursive: true, force: true });
  NodeFS.rmSync(second, { recursive: true, force: true });
  NodeFS.rmSync(NodePath.join(fakeHome, ".t3"), { recursive: true, force: true });
});

test("t3StateDbPath names the sqlite file inside a base dir", () => {
  assert.equal(t3StateDbPath("/tmp/base"), NodePath.join("/tmp/base", "state.sqlite"));
  assert.equal(
    t3StateDbPath("~/.t3/userdata"),
    NodePath.join(fakeHome, ".t3/userdata/state.sqlite"),
  );
});

test("t3WorktreesRoot follows HOME", () => {
  assert.equal(t3WorktreesRoot(), NodePath.join(fakeHome, ".t3", "worktrees"));
});

test("claudeProjectsDir defaults under HOME and honours its override", () => {
  assert.equal(claudeProjectsDir(), NodePath.join(fakeHome, ".claude", "projects"));

  process.env.WORKLOG_CLAUDE_PROJECTS = "~/elsewhere/projects";
  assert.equal(claudeProjectsDir(), NodePath.join(fakeHome, "elsewhere", "projects"));

  process.env.WORKLOG_CLAUDE_PROJECTS = "";
  assert.equal(claudeProjectsDir(), NodePath.join(fakeHome, ".claude", "projects"));
});

test("defaultWorklogRoot defaults to ~/Developer/worklog and honours WORKLOG_ROOT", () => {
  assert.equal(defaultWorklogRoot(), NodePath.join(fakeHome, "Developer", "worklog"));

  process.env.WORKLOG_ROOT = "~/logs";
  assert.equal(defaultWorklogRoot(), NodePath.join(fakeHome, "logs"));
});

test("worklogPaths lays out the repo exactly as the design specifies", () => {
  const root = NodePath.join(sandbox, "worklog-repo");
  assert.deepEqual(worklogPaths(root), {
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
    assert.ok(NodePath.isAbsolute(value), `${value} should be absolute`);
  }
});

test("worklogPaths falls back to the default root and resolves relative or ~ roots", () => {
  process.env.WORKLOG_ROOT = NodePath.join(sandbox, "configured");
  assert.equal(worklogPaths().root, NodePath.join(sandbox, "configured"));
  assert.equal(worklogPaths("").root, NodePath.join(sandbox, "configured"));

  assert.equal(worklogPaths("~/logs").root, NodePath.join(fakeHome, "logs"));
  assert.equal(worklogPaths("./relative/root").root, NodePath.resolve("relative/root"));
});

test("expandHome expands a bare ~, resolves, and refuses to guess ~user", () => {
  assert.equal(expandHome("~"), fakeHome);
  assert.equal(expandHome("~/a/b"), NodePath.join(fakeHome, "a", "b"));
  assert.equal(expandHome("/a/b/../c"), "/a/c");
  assert.equal(expandHome("  /a/b  "), "/a/b");
  assert.equal(expandHome("~someone/x"), NodePath.resolve("~someone/x"));
  assert.equal(expandHome(""), "");
  assert.equal(expandHome("   "), "");
  assert.equal(expandHome(null), "");
  assert.equal(expandHome(undefined), "");
  assert.equal(expandHome(42), "");
});

test("tildify hides the home prefix without matching a sibling directory", () => {
  assert.equal(tildify(fakeHome), "~");
  assert.equal(tildify(`${fakeHome}/`), "~");
  assert.equal(tildify(NodePath.join(fakeHome, "Developer", "t3code")), "~/Developer/t3code");
  assert.equal(tildify("~/Developer"), "~/Developer");

  // The prefix trap: "<home>2" merely starts with the home string.
  assert.equal(tildify(`${fakeHome}2/notes`), `${fakeHome}2/notes`);

  assert.equal(tildify("/opt/tools"), "/opt/tools");
  assert.equal(tildify("relative/path"), "relative/path");
  assert.equal(tildify(""), "");
  assert.equal(tildify(null), "");
});

test("safeKey folds to a filesystem-safe token", () => {
  assert.equal(safeKey("Hello, World!"), "hello-world");
  assert.equal(safeKey("T3 Code (fork)"), "t3-code-fork");
  assert.equal(safeKey("v1.2.3_final"), "v1.2.3_final");
  // The accent must fold to its base letter, not to a separator: "resume", never "re-sume".
  assert.equal(safeKey("Résumé"), "resume");
  assert.equal(safeKey("Café Ideas"), "cafe-ideas");
  assert.equal(safeKey("Zürich Möbel"), "zurich-mobel");
  assert.equal(safeKey("--already--collapsed--"), "already-collapsed");
  assert.equal(safeKey("/Users/x/Developer/t3code"), "users-x-developer-t3code");
  assert.equal(safeKey(42), "42");
});

test("safeKey never returns an empty or over-long key", () => {
  assert.equal(safeKey(""), "unknown");
  assert.equal(safeKey("   "), "unknown");
  assert.equal(safeKey("!!! ???"), "unknown");
  assert.equal(safeKey(null), "unknown");
  assert.equal(safeKey(undefined), "unknown");

  assert.equal(safeKey("a".repeat(200)), "a".repeat(80));
  // The 80-char cut lands on the separator, which must not survive as a trailing dash.
  assert.equal(safeKey(`${"a".repeat(79)} !! b`), "a".repeat(79));
});

test("slugify treats dots as separators too", () => {
  assert.equal(slugify("v1.2.3_final"), "v1-2-3_final");
  assert.equal(slugify("node.js Playground"), "node-js-playground");
  assert.equal(slugify("t3code"), "t3code");
  assert.equal(slugify("..."), "unknown");
  assert.equal(slugify("T3 Code (fork)"), safeKey("T3 Code (fork)"));
});

test("isUnder does segment containment, not string prefixing", () => {
  assert.equal(isUnder("/a/b/c", "/a/b"), true);
  assert.equal(isUnder("/a/b/c/d/e", "/a/b"), true);
  assert.equal(isUnder("/a/bc", "/a/b"), false);
  assert.equal(isUnder("/a/b-extra/x", "/a/b"), false);
  assert.equal(isUnder("/a/b", "/a/b"), true, "a path is under itself");
  assert.equal(isUnder("/a", "/a/b"), false);
  assert.equal(isUnder("/x/y", "/a/b"), false);
});

test("isUnder normalises both sides before comparing", () => {
  assert.equal(isUnder("/a/b/", "/a"), true);
  assert.equal(isUnder("/a/b/./c", "/a//b"), true);
  assert.equal(isUnder("/a/b/../c", "/a/b"), false);
  assert.equal(isUnder("~/.t3/worktrees/t3code-1", "~/.t3/worktrees"), true);
  assert.equal(isUnder(NodePath.join(fakeHome, ".t3/worktrees/x"), t3WorktreesRoot()), true);

  // "..foo" is a real directory name, not an escape.
  assert.equal(isUnder("/a/..foo", "/a"), true);

  assert.equal(isUnder("", "/a"), false);
  assert.equal(isUnder("/a", ""), false);
  assert.equal(isUnder(null, "/a"), false);
});

test("repoRelative falls back to the basename outside the root", () => {
  assert.equal(repoRelative("/repo", "/repo/src/index.ts"), "src/index.ts");
  assert.equal(repoRelative("/repo/", "/repo/a/b.txt"), "a/b.txt");
  assert.equal(repoRelative("/repo", "/other/place/file.ts"), "file.ts");
  assert.equal(repoRelative("/repo", "/repo"), "repo", "the root itself reads as its own name");
  assert.equal(repoRelative("/repo", "/repo-sibling/x.ts"), "x.ts");
  assert.equal(repoRelative("~/code", "~/code/lib/a.mjs"), "lib/a.mjs");
  assert.equal(repoRelative("", "/repo/src/index.ts"), "index.ts");
  assert.equal(repoRelative("/repo", ""), "");
  assert.equal(repoRelative("/repo", null), "");
});
