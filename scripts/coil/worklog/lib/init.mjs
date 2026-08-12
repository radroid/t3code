// Bootstrap for the worklog repo and discovery of the projects that belong in it —
// docs/coil/worklog-design.md §2 and §4.
//
// Three rules shape this module:
//
// 1. Nothing here is ever auto-confirmed. Discovery proposes; only a human promotes. Every
//    proposed entry is `confirmed: false`, which `registry.classify()` reads as "treated as
//    private", so a project discovered at 2am cannot name itself in tomorrow's report.
// 2. A human edit always wins. Re-running `init` may add a project or a root; it may never
//    change a `visibility`, a `confirmed`, or a `display_name` that is already written down.
// 3. Everything degrades. A missing database, an absent `git`, an unreadable transcript, a
//    directory that turns out to be a file — each becomes a warning and an emptier result,
//    never an exception out of a public function.
//
// Repo identity comes from `git.canonicalRepo`, whose key is the realpath of the repo's common
// `.git` directory. That is what makes the three t3code worktrees on this machine collapse into a
// single project instead of three lookalikes.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { scanSessions as scanClaudeSessions } from "./claudeCode.mjs";
import { canonicalRepo, createRunner, remoteNameWithOwner } from "./git.mjs";
import {
  claudeProjectsDir as defaultClaudeProjectsDir,
  expandHome,
  homeDir,
  isUnder,
  slugify,
  t3BaseDirs as defaultT3BaseDirs,
  worklogPaths,
} from "./paths.mjs";
import {
  loadRegistry,
  projectKeyFor,
  saveRedaction,
  saveRegistry,
  upsertProject,
} from "./registry.mjs";
import { closeDatabases, openT3Databases, readProjects, readThreads } from "./t3db.mjs";

/** How far back `init` scans Claude Code transcripts when discovering projects. */
const DISCOVERY_LOOKBACK_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The classification every discovered project starts with — unconfirmed, i.e. private. */
const PROPOSED = Object.freeze({ include: true, visibility: "generic", confirmed: false });

const INITIAL_COMMIT_MESSAGE = "Initialise the work log repo";

const GITIGNORE = [
  "# Scratch space: evidence bundles and transcript slices. Safe to delete at any time.",
  ".worklog-tmp/",
  "",
].join("\n");

/**
 * Discover the projects worth proposing, from T3code's project rows and Claude Code's session
 * directories, folded together by repo identity. Returns proposals only — nothing is confirmed.
 */
export function discoverProjects({
  t3Handles,
  ccSessions,
  run,
  existingRegistry,
  scratchRoots,
} = {}) {
  const exec = typeof run === "function" ? run : createRunner();
  const scratch = Array.isArray(scratchRoots) ? scratchRoots : DEFAULT_SCRATCH_ROOTS;
  const resolveRepo = repoResolver(exec);
  const groups = [];
  const byGroupKey = new Map();

  /** Find or start the group a directory belongs to; `null` when the path is unusable. */
  const groupForDir = (dir, { requireDirectory = false } = {}) => {
    const path = expandHome(dir);
    if (path === "") return null;
    if (isUnprojectableRoot(path, scratch)) return null;
    const repo = resolveRepo(path);
    // Session cwds go stale in bulk — T3code deletes a worktree the moment a thread is done — and
    // a proposal per dead directory would bury the real projects. A T3code project row is
    // different: it is a declared project with a title, so a missing root is still worth listing.
    if (repo === null && requireDirectory && !isDirectory(path)) return null;
    // A directory that is not in a repo is still a project root; it just cannot merge with a
    // sibling checkout, because there is no shared object store to prove they are the same thing.
    const groupKey = repo === null ? `path:${realPath(path)}` : `repo:${repo.key}`;
    const existing = byGroupKey.get(groupKey);
    const group = existing ?? newGroup(groupKey);
    if (existing === undefined) {
      byGroupKey.set(groupKey, group);
      groups.push(group);
    }
    if (repo === null) {
      addRoot(group, realPath(path));
    } else {
      group.repoRoot = repo.root;
      // The primary checkout goes first: a linked worktree is transient, the checkout it was made
      // from is the address a human recognises.
      if (repo.mainRoot !== null) addRoot(group, repo.mainRoot, { first: true });
      addRoot(group, repo.root);
    }
    return group;
  };

  // --- T3code projects. Their titles are the only human-authored names we get for free. -------
  const projectRows = attempt(() => [...readProjects(t3Handles)], []);
  const threadRows = attempt(() => [...readThreads(t3Handles, {})], []);

  const threadStats = new Map();
  for (const thread of threadRows) {
    // A deleted thread is not evidence that a project is alive.
    if (thread?.deletedAt) continue;
    const projectId = thread?.projectId;
    if (typeof projectId !== "string" || projectId === "") continue;
    const stats = threadStats.get(projectId) ?? { count: 0, lastSeen: null };
    stats.count += 1;
    stats.lastSeen = laterOf(stats.lastSeen, thread.updatedAt ?? thread.createdAt);
    threadStats.set(projectId, stats);
  }

  for (const row of projectRows) {
    if (row == null) continue;
    const stats = threadStats.get(row.projectId) ?? { count: 0, lastSeen: null };
    // A project with no workspace_root cannot be matched by path, but it still has threads and a
    // title, so it gets an entry of its own rather than vanishing from the registry.
    const group =
      groupForDir(row.workspaceRoot) ??
      startOrphanGroup(groups, byGroupKey, `project:${String(row.projectId)}`);
    if (group === null) continue;
    if (row.title) group.titles.push(row.title);
    group.projectIds.add(row.projectId);
    group.t3Threads += stats.count;
    group.lastSeen = laterOf(group.lastSeen, stats.lastSeen);
    if (row.deletedAt) group.deletedRows += 1;
    else group.liveRows += 1;
  }

  // --- Claude Code sessions. Only the cwd matters here. ---------------------------------------
  for (const session of Array.isArray(ccSessions) ? ccSessions : []) {
    if (session == null || typeof session !== "object") continue;
    const group = groupForDir(session.cwd, { requireDirectory: true });
    if (group === null) continue;
    group.ccSessions += 1;
    group.lastSeen = laterOf(group.lastSeen, session.endedAt ?? session.startedAt);
  }

  // --- Name, key, and evidence ----------------------------------------------------------------
  const registry = isPlainObject(existingRegistry) ? existingRegistry : null;
  const taken = new Set(Object.keys(isPlainObject(registry?.projects) ? registry.projects : {}));
  const discovered = [];

  for (const group of groups) {
    // A group whose only evidence is a deleted T3code project is a project that no longer exists.
    if (group.liveRows === 0 && group.t3Threads === 0 && group.ccSessions === 0) continue;

    const displayName = group.titles[0] ?? basenameOfRoot(group) ?? "Unknown project";
    const key = chooseKey(registry, taken, group, displayName);
    taken.add(key);

    discovered.push({
      key,
      displayName,
      roots: [...group.roots],
      evidence: {
        t3Threads: group.t3Threads,
        ccSessions: group.ccSessions,
        lastSeen: group.lastSeen,
        nameWithOwner:
          group.repoRoot === null
            ? null
            : (attempt(() => remoteNameWithOwner(group.repoRoot, exec), null) ?? null),
      },
      proposed: { ...PROPOSED },
    });
  }

  return discovered;
}

/** The registry key whose roots contain `root` exactly, or null. */
function exactRootOwner(registry, root) {
  const target = realPath(expandHome(root));
  if (target === "") return null;
  const projects = isPlainObject(registry?.projects) ? registry.projects : {};
  for (const [key, entry] of Object.entries(projects)) {
    for (const candidate of Array.isArray(entry?.roots) ? entry.roots : []) {
      if (realPath(expandHome(candidate)) === target) return key;
    }
  }
  return null;
}

/** The scratch trees a session cwd may sit in without that making it a project. */
export const DEFAULT_SCRATCH_ROOTS = Object.freeze([
  NodeOS.tmpdir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
]);

/**
 * True for a directory that must never become a project root. A session's cwd is sometimes the home
 * directory or a scratch dir, and either one is worse than useless as a project: `matchProjectByRoot`
 * resolves by path containment, so an entry rooted at `~` would silently claim every other project's
 * sessions — and an unconfirmed entry counts toward the totals, so the misattribution is invisible.
 *
 * `scratchRoots` is a parameter rather than a constant because the tests build their fixtures in
 * exactly the directories production wants to ignore.
 */
function isUnprojectableRoot(path, scratchRoots) {
  const resolved = realPath(NodePath.resolve(path));
  if (resolved === "" || resolved === NodePath.parse(resolved).root) return true;
  if (resolved === realPath(homeDir())) return true;
  for (const dir of scratchRoots) {
    const scratch = realPath(dir);
    if (scratch !== "" && (resolved === scratch || isUnder(resolved, scratch))) return true;
  }
  return false;
}

/**
 * Create the worklog repo's directory tree, README, `.gitignore` and empty config files, and
 * `git init` + commit when the root is not already a repo. Idempotent; never clobbers config.
 */
export function scaffold({ root, force = false, run } = {}) {
  const paths = worklogPaths(root);
  const created = [];
  const existed = [];
  const rewritten = [];
  const warnings = [];

  for (const dir of [
    paths.root,
    paths.config,
    paths.days,
    paths.ranges,
    paths.extracts,
    paths.tmp,
    paths.slices,
    paths.bundles,
  ]) {
    ensureDir(dir, { created, existed, warnings });
  }

  // README and .gitignore are ours, so `--force` may rewrite them. The config files are the
  // human's — `--force` still leaves those alone, because they hold classification decisions that
  // took a conversation to make.
  ensureFile(NodePath.join(paths.root, "README.md"), readmeText(), {
    force,
    created,
    existed,
    rewritten,
    warnings,
  });
  ensureFile(NodePath.join(paths.root, ".gitignore"), GITIGNORE, {
    force,
    created,
    existed,
    rewritten,
    warnings,
  });

  ensureConfig(paths.projectsYaml, () => saveRegistry(paths, {}), { created, existed, warnings });
  ensureConfig(paths.redactionYaml, () => saveRedaction(paths, {}), { created, existed, warnings });

  const git = ensureGitRepo(paths.root, run, warnings);

  return {
    root: paths.root,
    created,
    existed,
    rewritten,
    warnings,
    gitInitialized: git.initialized,
    committed: git.committed,
  };
}

/**
 * Scaffold the repo, discover projects, and merge them into the registry without ever overwriting
 * a human's decision. Async because the Claude Code transcript scan is.
 */
export async function init({ root, deps = {} } = {}) {
  const paths = worklogPaths(root);
  const options = isPlainObject(deps) ? deps : {};
  const warnings = [];

  const scaffolded = scaffold({
    root: paths.root,
    force: options.force === true,
    run: options.run,
  });
  warnings.push(...scaffolded.warnings);

  const loaded = loadRegistry(paths);
  const registry = loaded.registry;
  warnings.push(...loaded.warnings);

  const discovered = await discoverWithDeps(options, registry, warnings);

  const added = [];
  const updated = [];
  const unchanged = [];

  for (const project of discovered) {
    const projects = isPlainObject(registry.projects) ? registry.projects : {};
    const existing = Object.hasOwn(projects, project.key) ? projects[project.key] : undefined;
    const isNew = !isPlainObject(existing);
    const before = isNew ? null : JSON.stringify(existing);

    const patch = { roots: project.roots };
    if (isNew) {
      patch.displayName = project.displayName;
      Object.assign(patch, project.proposed);
    } else if (!isNonEmptyString(existing.displayName)) {
      // Filling in a blank is not a downgrade; changing a name a human typed would be.
      patch.displayName = project.displayName;
    }
    upsertProject(registry, project.key, patch);

    if (isNew) added.push(project.key);
    else if (JSON.stringify(registry.projects[project.key]) !== before) updated.push(project.key);
    else unchanged.push(project.key);
  }

  // Saving is conditional because `stringifyYaml` cannot preserve comments a human wrote by hand;
  // a no-op run must not cost them their notes.
  if (added.length > 0 || updated.length > 0) {
    try {
      saveRegistry(paths, registry);
    } catch (error) {
      warnings.push(`Could not write ${paths.projectsYaml}: ${errorMessage(error)}`);
    }
  }

  return {
    root: paths.root,
    created: scaffolded.created,
    existed: scaffolded.existed,
    discovered,
    added,
    updated,
    unchanged,
    registryPath: paths.projectsYaml,
    warnings,
    gitInitialized: scaffolded.gitInitialized,
  };
}

// --- discovery internals -------------------------------------------------------------------

function newGroup(groupKey) {
  return {
    groupKey,
    titles: [],
    roots: [],
    repoRoot: null,
    projectIds: new Set(),
    t3Threads: 0,
    ccSessions: 0,
    liveRows: 0,
    deletedRows: 0,
    lastSeen: null,
  };
}

// A T3code project row whose workspace_root is missing or unreadable still deserves an entry.
function startOrphanGroup(groups, byGroupKey, groupKey) {
  const existing = byGroupKey.get(groupKey);
  if (existing !== undefined) return existing;
  const group = newGroup(groupKey);
  byGroupKey.set(groupKey, group);
  groups.push(group);
  return group;
}

/** Memoised `canonicalRepo`: one directory can appear in hundreds of sessions, git spawns are not free. */
function repoResolver(run) {
  const cache = new Map();
  return function resolve(path) {
    if (cache.has(path)) return cache.get(path);
    let value = null;
    // Asking git about a path that is not a directory costs a process and always fails.
    if (isDirectory(path)) {
      const repo = attempt(() => canonicalRepo(path, run), null);
      if (repo != null && isNonEmptyString(repo.root)) {
        value = { key: repo.key, root: repo.root, mainRoot: mainCheckoutOf(repo.key) };
      }
    }
    cache.set(path, value);
    return value;
  };
}

// `canonicalRepo().key` is the realpath of the repo's common git dir, so for an ordinary checkout
// its parent is the primary working tree — the directory a linked worktree was branched from.
function mainCheckoutOf(commonDir) {
  if (!isNonEmptyString(commonDir) || NodePath.basename(commonDir) !== ".git") return null;
  const parent = NodePath.dirname(commonDir);
  return isDirectory(parent) ? parent : null;
}

function addRoot(group, root, { first = false } = {}) {
  if (!isNonEmptyString(root)) return;
  if (group.roots.includes(root)) return;
  if (first) group.roots.unshift(root);
  else group.roots.push(root);
}

function basenameOfRoot(group) {
  const root = group.roots[0];
  return isNonEmptyString(root) ? NodePath.basename(root) : null;
}

/**
 * Which registry key this group belongs to. Root evidence beats the name, so two projects that
 * share a title but not a repo get separate entries — which is exactly the t3code case.
 */
function chooseKey(registry, taken, group, displayName) {
  if (registry !== null) {
    // Exact roots only. `matchProjectByRoot` resolves by containment, which is right when
    // attributing a session to a project and wrong here: a repo nested inside another repo's
    // directory tree (inbox-lens under mission-control) would adopt its parent's key and vanish.
    for (const root of group.roots) {
      const match = exactRootOwner(registry, root);
      if (match !== null) return match;
    }
    // An entry a human wrote by hand often has no roots yet; the name is then the only link, and
    // adopting it is what lets `init` fill in the paths they did not want to look up.
    const slug = slugify(displayName);
    const projects = isPlainObject(registry.projects) ? registry.projects : {};
    if (Object.hasOwn(projects, slug)) {
      const entry = projects[slug];
      const roots = Array.isArray(entry?.roots) ? entry.roots : [];
      if (roots.length === 0) return slug;
    }
  }
  return projectKeyFor(displayName, taken);
}

// Opens the databases and scans the transcripts that `discoverProjects` needs, unless the caller
// injected them. Everything in here is best-effort: a failed scan means fewer proposals, not a
// failed `init`.
async function discoverWithDeps(options, registry, warnings) {
  const run = typeof options.run === "function" ? options.run : createRunner();

  let handles = options.t3Handles;
  let ownsHandles = false;
  if (!Array.isArray(handles)) {
    const baseDirs = Array.isArray(options.t3BaseDirs) ? options.t3BaseDirs : defaultT3BaseDirs();
    const opened = attempt(() => openT3Databases(baseDirs), { handles: [], warnings: [] });
    handles = opened.handles;
    warnings.push(...opened.warnings);
    ownsHandles = true;
  }

  try {
    let sessions = options.ccSessions;
    if (!Array.isArray(sessions)) {
      sessions = await scanForSessions(options, warnings);
    }
    return discoverProjects({
      t3Handles: handles,
      ccSessions: sessions,
      run,
      existingRegistry: registry,
      scratchRoots: options.scratchRoots,
    });
  } catch (error) {
    warnings.push(`Project discovery failed: ${errorMessage(error)}`);
    return [];
  } finally {
    if (ownsHandles) closeDatabases(handles);
  }
}

async function scanForSessions(options, warnings) {
  const dir = isNonEmptyString(options.claudeProjectsDir)
    ? options.claudeProjectsDir
    : defaultClaudeProjectsDir();
  const scan =
    typeof options.scanSessions === "function" ? options.scanSessions : scanClaudeSessions;
  try {
    const result = await scan(dir, { start: lookbackStart(options), limit: options.sessionLimit });
    warnings.push(...(Array.isArray(result?.warnings) ? result.warnings : []));
    return Array.isArray(result?.sessions) ? result.sessions : [];
  } catch (error) {
    warnings.push(`Could not scan Claude Code transcripts in ${dir}: ${errorMessage(error)}`);
    return [];
  }
}

// Discovery only needs to know which projects are live, and the mtime prefilter in
// `listSessionFiles` turns a bounded lookback into far fewer files opened. `lookbackDays: null`
// asks for everything.
function lookbackStart(options) {
  if (isNonEmptyString(options.since)) return options.since;
  if (options.lookbackDays === null) return undefined;
  const days =
    typeof options.lookbackDays === "number" &&
    Number.isFinite(options.lookbackDays) &&
    options.lookbackDays >= 0
      ? options.lookbackDays
      : DISCOVERY_LOOKBACK_DAYS;
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// --- scaffold internals --------------------------------------------------------------------

function ensureDir(dir, { created, existed, warnings }) {
  const stats = statOf(dir);
  if (stats?.isDirectory()) {
    existed.push(dir);
    return;
  }
  if (stats != null) {
    warnings.push(`Expected a directory at ${dir} but found a file; left it alone.`);
    return;
  }
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    created.push(dir);
  } catch (error) {
    warnings.push(`Could not create ${dir}: ${errorMessage(error)}`);
  }
}

function ensureFile(file, contents, { force, created, existed, rewritten, warnings }) {
  const current = readIfPresent(file);
  if (current !== null) {
    existed.push(file);
    if (!force || current === contents) return;
    try {
      NodeFS.writeFileSync(file, contents, "utf8");
      rewritten.push(file);
    } catch (error) {
      warnings.push(`Could not rewrite ${file}: ${errorMessage(error)}`);
    }
    return;
  }
  try {
    NodeFS.writeFileSync(file, contents, "utf8");
    created.push(file);
  } catch (error) {
    warnings.push(`Could not create ${file}: ${errorMessage(error)}`);
  }
}

// Config is never rewritten, not even with `--force`: `worklog init` is a bootstrap, and the file
// it would clobber is the one holding every "yes, you may name this project" a human has given.
function ensureConfig(file, write, { created, existed, warnings }) {
  if (statOf(file) != null) {
    existed.push(file);
    return;
  }
  try {
    write();
    created.push(file);
  } catch (error) {
    warnings.push(`Could not create ${file}: ${errorMessage(error)}`);
  }
}

function ensureGitRepo(root, run, warnings) {
  const exec = typeof run === "function" ? run : createRunner();
  const idle = { initialized: false, committed: false };

  // `git rev-parse --show-toplevel` rather than a test for `.git`, because a linked worktree keeps
  // a *file* there, and a root nested inside another repo would answer with the parent's toplevel —
  // which must still get its own repo, not be committed into its host.
  const toplevel = attempt(
    () => exec("git", ["rev-parse", "--show-toplevel"], { cwd: root }),
    null,
  );
  if (toplevel?.ok && samePath(toplevel.stdout.trim(), root)) return idle;

  let started = attempt(() => exec("git", ["init", "-b", "main"], { cwd: root }), null);
  // `-b` needs git 2.28; on anything older the branch name is whatever the user configured.
  if (!started?.ok) started = attempt(() => exec("git", ["init"], { cwd: root }), null);
  if (!started?.ok) {
    warnings.push(
      `Could not create a git repo in ${root}: ${firstLine(started?.stderr) || "git unavailable"}. ` +
        "The files are in place; run `git init` there by hand.",
    );
    return idle;
  }

  const staged = attempt(() => exec("git", ["add", "-A"], { cwd: root }), null);
  if (!staged?.ok) {
    warnings.push(
      `Created the git repo in ${root} but could not stage it: ${firstLine(staged?.stderr)}`,
    );
    return { initialized: true, committed: false };
  }

  const committed = attempt(
    () => exec("git", ["commit", "-m", INITIAL_COMMIT_MESSAGE], { cwd: root }),
    null,
  );
  if (!committed?.ok) {
    // Almost always a missing `user.email`. Not worth failing a bootstrap over, and definitely not
    // worth inventing an identity for a repo that holds the user's own work log.
    warnings.push(
      `Created the git repo in ${root} but could not make the initial commit: ` +
        `${firstLine(committed?.stderr) || "unknown error"}. Commit it by hand once git is configured.`,
    );
    return { initialized: true, committed: false };
  }
  return { initialized: true, committed: true };
}

function readmeText() {
  return [
    "# Work log",
    "",
    "Generated and maintained by the `/worklog` Claude Code skill.",
    "",
    "## This repo is private by default, and has no remote",
    "",
    "Nothing in here is published anywhere. `worklog publish` only lints and commits locally — it",
    "never pushes, and no remote is configured. Adding one is a deliberate act; read the rest of",
    "this file first.",
    "",
    "## What may eventually be published, and what may never be",
    "",
    "| Path | What it holds | Publishable |",
    "| --- | --- | --- |",
    "| `days/` | The reviewed day reports | **Yes — this is the only directory intended for eventual publication.** |",
    "| `ranges/` | Multi-day drafts assembled from the same material | No. Drafts; review them like a day file before sharing anything from them. |",
    "| `extracts/` | Per-session condensed extracts, straight from raw transcripts | **Never.** Pre-redaction: paths, branch names and client names have not been through the lint gate. |",
    "| `config/redaction.yaml` | The list of terms that must never appear in a report | **Never.** It is literally an index of the sensitive words. |",
    "| `config/projects.yaml` | Which projects may be named, and how | No. It maps project names to absolute paths on this machine. |",
    "| `.worklog-tmp/` | Evidence bundles and transcript slices | Never — and it is gitignored. Safe to delete at any time. |",
    "",
    "## The rule that keeps a day file safe",
    "",
    "A project is described in a report only when its entry in `config/projects.yaml` says",
    "`confirmed: true`. Anything discovered automatically arrives as `confirmed: false`, which is",
    "treated as private: its work is counted in the totals, and it is never named or described.",
    "Promoting a project is a decision only you can make — edit the file by hand.",
    "",
    "`worklog lint` blocks a report that leaks a home path, an email address, a secret-shaped",
    "string, a redaction term, or the name of a project that is not `public` + `confirmed`.",
    "",
  ].join("\n");
}

// --- shared internals ----------------------------------------------------------------------

// Every public function in this module promises not to throw. `attempt` is where that promise is
// actually kept for the calls that reach the filesystem, git, or SQLite.
function attempt(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function statOf(p) {
  try {
    return NodeFS.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}

function isDirectory(p) {
  return statOf(p)?.isDirectory() === true;
}

function readIfPresent(file) {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// macOS hands out /var/folders paths that are really /private/var/folders, so two spellings of one
// directory are the normal case, not an edge case.
function realPath(p) {
  try {
    return NodeFS.realpathSync(p);
  } catch {
    return p;
  }
}

function samePath(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  return realPath(NodePath.resolve(left)) === realPath(NodePath.resolve(right));
}

function laterOf(current, candidate) {
  if (!isNonEmptyString(candidate)) return current;
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(candidateMs)) return current;
  const iso = new Date(candidateMs).toISOString();
  if (current === null) return iso;
  return iso > current ? iso : current;
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
