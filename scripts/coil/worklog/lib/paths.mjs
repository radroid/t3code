// Every filesystem location the /worklog collector touches is derived here.
//
// One reason this is a module and not a scattering of string literals: the whole pipeline is
// read-only toward the user's data, and the cheapest way to keep it that way under test is for
// a test to move HOME (plus the three WORKLOG_* overrides) to a temp directory and have every
// other module follow automatically. Nothing below caches, so an override set mid-process is
// honoured by the next call.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Long enough to stay readable in `extracts/<key>.json`, short enough to survive a nested
// checkout on a filesystem with a 255-byte name limit.
const KEY_MAX_LENGTH = 80;

// A key must never be empty: it becomes a filename and a bundle map key.
const EMPTY_KEY_FALLBACK = "unknown";

/** The current user's home directory, honouring a HOME override so tests can relocate it. */
export function homeDir() {
  const fromEnv = process.env.HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return NodePath.resolve(fromEnv.trim());
  return NodeOS.homedir();
}

/** Expands a leading `~` and resolves to an absolute path; returns "" for empty/non-string input. */
export function expandHome(p) {
  if (typeof p !== "string") return "";
  const trimmed = p.trim();
  if (trimmed === "") return "";
  if (trimmed === "~") return homeDir();
  // Only a bare `~` is expanded. `~someone` is another user's home, which we cannot resolve
  // without a passwd lookup, so it is left alone rather than silently pointed at this user.
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${NodePath.sep}`)) {
    return NodePath.resolve(NodePath.join(homeDir(), trimmed.slice(2)));
  }
  return NodePath.resolve(trimmed);
}

/** Replaces the home-directory prefix of a path with `~`, for display and for redaction checks. */
export function tildify(p) {
  if (typeof p !== "string" || p.trim() === "") return "";
  const trimmed = p.trim();
  const target = stripTrailingSeparators(
    trimmed.startsWith("~") ? expandHome(trimmed) : NodePath.normalize(trimmed),
  );
  // A relative path has no home prefix to hide, and resolving it here would leak the cwd.
  if (!NodePath.isAbsolute(target)) return target;
  const home = stripTrailingSeparators(homeDir());
  if (target === home) return "~";
  if (!isUnder(target, home)) return target;
  return `~${NodePath.sep}${NodePath.relative(home, target)}`;
}

/**
 * The T3code state directories that actually exist, newest-first by convention (userdata, dev).
 * Override with WORKLOG_T3_BASE_DIRS (colon-separated); entries that do not exist are still
 * dropped, because every caller wants a list it can open.
 */
export function t3BaseDirs() {
  const override = process.env.WORKLOG_T3_BASE_DIRS;
  const candidates =
    typeof override === "string" && override.trim() !== ""
      ? override
          .split(":")
          .map((entry) => expandHome(entry))
          .filter((entry) => entry !== "")
      : [NodePath.join(homeDir(), ".t3", "userdata"), NodePath.join(homeDir(), ".t3", "dev")];

  const seen = new Set();
  const dirs = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (isDirectory(dir)) dirs.push(dir);
  }
  return dirs;
}

/** The SQLite file inside a T3code state directory. */
export function t3StateDbPath(baseDir) {
  return NodePath.join(expandHome(baseDir), "state.sqlite");
}

/** Root of the T3code worktree checkouts — the strongest signal that a session is T3code-driven. */
export function t3WorktreesRoot() {
  return NodePath.join(homeDir(), ".t3", "worktrees");
}

/** Directory holding Claude Code's per-project JSONL transcripts (override: WORKLOG_CLAUDE_PROJECTS). */
export function claudeProjectsDir() {
  const override = process.env.WORKLOG_CLAUDE_PROJECTS;
  if (typeof override === "string" && override.trim() !== "") return expandHome(override);
  return NodePath.join(homeDir(), ".claude", "projects");
}

/** The worklog repo root (override: WORKLOG_ROOT). */
export function defaultWorklogRoot() {
  const override = process.env.WORKLOG_ROOT;
  if (typeof override === "string" && override.trim() !== "") return expandHome(override);
  return NodePath.join(homeDir(), "Developer", "worklog");
}

/** Every path inside a worklog repo, absolute. Falls back to the default root when none is given. */
export function worklogPaths(root) {
  const base = expandHome(root) || defaultWorklogRoot();
  const config = NodePath.join(base, "config");
  const tmp = NodePath.join(base, ".worklog-tmp");
  return {
    root: base,
    config,
    projectsYaml: NodePath.join(config, "projects.yaml"),
    redactionYaml: NodePath.join(config, "redaction.yaml"),
    days: NodePath.join(base, "days"),
    ranges: NodePath.join(base, "ranges"),
    extracts: NodePath.join(base, "extracts"),
    tmp,
    slices: NodePath.join(tmp, "slices"),
    bundles: NodePath.join(tmp, "bundles"),
  };
}

/** Filesystem-safe key: lowercased, non-`[a-z0-9._-]` folded to `-`, collapsed, trimmed, ≤ 80 chars. */
export function safeKey(s) {
  return toKey(s, /[^a-z0-9._-]+/gu);
}

/** Like `safeKey` but dots are separators too — used for project keys, which appear in prose. */
export function slugify(s) {
  return toKey(s, /[^a-z0-9_-]+/gu);
}

/**
 * True path-segment containment: `/a/bc` is not under `/a/b`. A path is under itself.
 * Both sides are `~`-expanded and resolved first, so mixed forms compare correctly.
 */
export function isUnder(child, parent) {
  const childPath = expandHome(child);
  const parentPath = expandHome(parent);
  if (childPath === "" || parentPath === "") return false;
  const rel = NodePath.relative(parentPath, childPath);
  if (rel === "") return true;
  // An absolute result means the two are on different roots (Windows drives); `..` means the
  // child escapes the parent. Checking the `..` segment — not the prefix — is what stops
  // "..foo" from reading as an escape.
  if (NodePath.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${NodePath.sep}`);
}

/** Path relative to `root`, or just the basename when it falls outside `root` (or is `root`). */
export function repoRelative(root, p) {
  const target = expandHome(p);
  if (target === "") return "";
  const base = expandHome(root);
  if (base !== "" && isUnder(target, base)) {
    const rel = NodePath.relative(base, target);
    if (rel !== "") return rel;
  }
  return NodePath.basename(target);
}

function toKey(value, disallowed) {
  if (value === null || value === undefined) return EMPTY_KEY_FALLBACK;
  const key = String(value)
    // Decompose then drop the combining marks, so "Café" keys as "cafe" rather than "caf-".
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(disallowed, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, KEY_MAX_LENGTH)
    // The slice can land mid-run and leave a dangling separator.
    .replace(/-+$/gu, "");
  return key === "" ? EMPTY_KEY_FALLBACK : key;
}

function isDirectory(p) {
  try {
    return NodeFS.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    // EACCES on a parent, a symlink loop, a path longer than the OS allows — all mean
    // "cannot use this directory", never "abort the run".
    return false;
  }
}

function stripTrailingSeparators(p) {
  const stripped = p.replace(/[\\/]+$/u, "");
  return stripped === "" ? p.slice(0, 1) : stripped;
}
