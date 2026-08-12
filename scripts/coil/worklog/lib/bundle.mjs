// The evidence bundle — the deterministic half of /worklog (design §7).
//
// `collect()` reads T3code's SQLite projections, Claude Code's JSONL transcripts and git/`gh`, and
// emits ONE JSON object describing a range of days. The model never touches the raw stores; it
// reads `renderSummary()` of this object. Four invariants are what make the numbers trustworthy:
//
//   1. Parallel work is never double-counted. Active time is the union of blocks over the MERGED
//      event stream (§5), so two sessions running at once cost one hour, not two.
//   2. The same work is never counted twice across stores. T3code drives Claude Code, so a linked
//      session stays in the bundle carrying `excluded` and contributes nothing to any total (§6).
//   3. Nothing is dropped. A private or unclassified project still appears, with its classification
//      attached, because the model has to know it was touched for the stats to add up. Only a
//      project the human explicitly set `include: false` on is left out of the totals.
//   4. Per-day numbers sum to the range totals. Durations are clipped into each day; counts are
//      attributed to the day the thing started, clamped into the window. (The one exception is
//      `filesTouched`, which is a distinct count and therefore cannot sum — see `byDay` below.)
//
// Two numbers are honest only because they are qualified in the data rather than in prose:
//
//   * `agentRuntimeMs` excludes the stretches a turn spent BLOCKED ON THE HUMAN — see
//     `humanWaits` — and the subtracted total ships beside it as `awaitingInputMs` so the
//     correction is auditable instead of invisible.
//   * `files`/`filesTouched` come from turn checkpoints, which upstream computes as a diff between
//     workspace SNAPSHOTS, so they are an upper bound and say so: `filesApproximate`.
//
// Every collector is wrapped: a missing database, a corrupt payload, an absent `gh` or a dead
// network becomes a warning and an empty result. The only thing `collect` throws for is an
// unparseable `--from`/`--to`, which is a usage error the CLI must surface rather than paper over.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as DefaultClaudeCode from "./claudeCode.mjs";
import { extractPath, loadExtract, needsExtraction as needsExtractionOf } from "./extract.mjs";
import {
  formatLocalDate,
  localDayKey,
  pluralize,
  rangeWindow,
  timezoneName,
  toIso,
} from "./format.mjs";
import * as DefaultGit from "./git.mjs";
import * as DefaultPaths from "./paths.mjs";
import * as DefaultRegistry from "./registry.mjs";
import * as DefaultT3Db from "./t3db.mjs";
import { activeTimeline, agentRuntimeMs as spanMs, splitByDay, toMs } from "./timeline.mjs";

/** Bump only alongside a documented change to §7 of docs/coil/worklog-design.md. */
export const SCHEMA_VERSION = 1;

const MINUTE_MS = 60_000;

/** Session titles are headings in the summary, not prose; anything longer is noise. */
const TITLE_MAX_CHARS = 100;

/** Distinct task titles kept per session. The narrative needs a hint, not a transcript. */
const MAX_TASK_SIGNALS = 4;

// The scanner already truncates to the same limit; re-applying it here is what stops a bundle from
// inheriting a fake's (or a future scanner's) unbounded prompt. The bundle IS the model's budget.
const PROMPT_MAX_CHARS = 2000;

// T3code's names for "the turn stopped and is waiting for the human" and "the answer landed".
const INPUT_REQUESTED = "user-input.requested";
const INPUT_RESOLVED = "user-input.resolved";

/** "Still running" while a span is being split; `timeline.mjs` wants it back as a `null` end. */
const OPEN_END = Number.POSITIVE_INFINITY;

/**
 * Build the evidence bundle for `[from, to]` (inclusive, local days).
 *
 * `deps` exists for tests: any of `{ t3db, claudeCode, git, registry, paths, run }` may be a partial
 * override, merged over the real module. Throws only when `from`/`to` are not real calendar dates.
 */
export async function collect({
  from,
  to,
  worklogRoot,
  gapMinutes,
  includeGit = true,
  now = Date.now(),
  deps = {},
  // The CLI owns one shell runner for the whole process and passes it at the top level. Honouring
  // it here is what keeps `worklog collect` from quietly spawning a second, untracked one.
  run,
} = {}) {
  const warnings = [];
  const overrides = isObject(deps) ? deps : {};
  const mods = resolveDeps(typeof overrides.run === "function" ? overrides : { ...overrides, run });
  const nowMs = toMs(now) ?? Date.now();

  const fromDay = dayArg(from, formatLocalDate(nowMs));
  const toDay = dayArg(to, fromDay);
  const range = rangeWindow(fromDay, toDay);
  const window = { start: range.start.getTime(), end: range.end.getTime() };
  const windowIso = { start: range.start.toISOString(), end: range.end.toISOString() };

  const paths = attempt(
    () => mods.paths.worklogPaths(worklogRoot),
    () => DefaultPaths.worklogPaths(worklogRoot),
    "Resolving the worklog paths",
    warnings,
  );

  const registry = loadRegistry(mods, paths, warnings);
  const settings = attempt(
    () => mods.registry.settingsOf(registry),
    () => ({ ...DefaultRegistry.DEFAULT_SETTINGS }),
    "Reading the registry defaults",
    warnings,
  );
  const identities = attempt(
    () => mods.registry.identitiesOf(registry),
    () => [],
    "Reading the registry identities",
    warnings,
  );
  // The redaction list does not shape the bundle — it is loaded so a missing or malformed one is
  // reported here, long before `worklog lint` becomes the last line of defence.
  attempt(
    () => absorb(mods.registry.loadRedaction(paths), warnings),
    () => null,
    "Reading the redaction list",
    warnings,
  );

  const activeGapMinutes =
    positiveNumber(gapMinutes) ?? positiveNumber(settings.activeGapMinutes) ?? 30;
  const singleEventMinutes = positiveNumber(settings.singleEventMinutes) ?? 1;
  const blockOptions = {
    gapMs: activeGapMinutes * MINUTE_MS,
    singleEventMs: singleEventMinutes * MINUTE_MS,
    window,
  };

  const t3BaseDirs = attempt(
    () => mods.paths.t3BaseDirs(),
    () => [],
    "Locating the T3code state directories",
    warnings,
  );
  const claudeProjectsDir = attempt(
    () => mods.paths.claudeProjectsDir(),
    () => "",
    "Locating the Claude Code transcripts",
    warnings,
  );

  const t3 = readT3(mods, t3BaseDirs, windowIso, nowMs, warnings);
  const claude = await readClaudeCode(mods, claudeProjectsDir, window, t3, warnings);

  const projects = createProjectIndex({ mods, registry, run: mods.run, includeGit, warnings });
  const contributions = [];

  for (const thread of t3.threads) {
    const contribution = buildThreadSession({
      mods,
      thread,
      t3,
      window,
      blockOptions,
      nowMs,
      paths,
      projects,
      warnings,
    });
    if (contribution !== null) contributions.push(contribution);
  }
  for (const session of claude.sessions) {
    const contribution = buildClaudeSession({
      session,
      window,
      blockOptions,
      nowMs,
      paths,
      projects,
      warnings,
    });
    if (contribution !== null) contributions.push(contribution);
  }

  const git = includeGit
    ? collectRepos({ mods, projects, window, identities, warnings })
    : { repos: [] };

  const rollup = rollUp({ contributions, git, projects, range, window, blockOptions, nowMs });

  contributions.sort(
    (left, right) =>
      String(left.session.startedAt ?? "").localeCompare(String(right.session.startedAt ?? "")) ||
      left.session.key.localeCompare(right.session.key),
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    warnings: dedupe(warnings),
    range: { from: fromDay, to: toDay, days: range.days, timezone: timezoneName() },
    config: {
      activeGapMinutes,
      singleEventMinutes,
      worklogRoot: paths.root,
      t3BaseDirs,
      claudeProjectsDir,
      includeGit: includeGit === true,
    },
    projects: rollup.projects,
    unclassified: rollup.unclassified,
    sessions: contributions.map((contribution) => contribution.session),
    git: { repos: git.repos },
    stats: rollup.stats,
    byDay: rollup.byDay,
  };
}

// --- stores -------------------------------------------------------------------------------------

function loadRegistry(mods, paths, warnings) {
  const loaded = attempt(
    () => mods.registry.loadRegistry(paths),
    () => ({ registry: { version: 1, identities: [], defaults: {}, projects: {} }, warnings: [] }),
    "Reading the project registry",
    warnings,
  );
  absorb(loaded, warnings);
  return loaded?.registry ?? { version: 1, identities: [], defaults: {}, projects: {} };
}

// Everything the T3code databases contribute, read once and indexed by thread.
function readT3(mods, baseDirs, windowIso, nowMs, warnings) {
  const empty = {
    projects: new Map(),
    threads: [],
    turnsByThread: new Map(),
    activitiesByThread: new Map(),
    promptHashes: new Map(),
  };

  const opened = attempt(
    () => mods.t3db.openT3Databases(baseDirs),
    () => ({ handles: [], warnings: [] }),
    "Opening the T3code databases",
    warnings,
  );
  absorb(opened, warnings);
  const handles = Array.isArray(opened?.handles) ? opened.handles : [];
  if (handles.length === 0) return empty;

  try {
    const projectRows = read(
      () => mods.t3db.readProjects(handles),
      [],
      "Reading T3code projects",
      warnings,
    );
    const projects = new Map();
    for (const row of projectRows) projects.set(projectRowKey(row.baseDir, row.projectId), row);

    const threads = read(
      () => mods.t3db.readThreads(handles, windowIso),
      [],
      "Reading T3code threads",
      warnings,
    ).filter((thread) => typeof thread?.threadId === "string" && thread.threadId !== "");
    const threadIds = threads.map((thread) => thread.threadId);

    const turnOptions = { ...windowIso, now: new Date(nowMs).toISOString() };
    const turns = read(
      () => mods.t3db.readTurns(handles, threadIds, turnOptions),
      [],
      "Reading T3code turns",
      warnings,
    );
    const activities = read(
      () => mods.t3db.readActivities(handles, threadIds, windowIso),
      [],
      "Reading T3code activity",
      warnings,
    );
    const promptHashes = read(
      () => mods.t3db.promptHashIndex(handles, windowIso),
      new Map(),
      "Indexing T3code prompts",
      warnings,
    );

    return {
      projects,
      threads,
      turnsByThread: groupBy(turns, (turn) => turn.threadId),
      activitiesByThread: groupBy(activities, (activity) => activity.threadId),
      promptHashes,
    };
  } finally {
    attempt(
      () => mods.t3db.closeDatabases(handles),
      () => null,
      "Closing the T3code databases",
      warnings,
    );
  }
}

async function readClaudeCode(mods, projectsDir, window, t3, warnings) {
  const scan = await attemptAsync(
    () => mods.claudeCode.scanSessions(projectsDir, { start: window.start, end: window.end }),
    () => ({ sessions: [], warnings: [] }),
    "Scanning the Claude Code transcripts",
    warnings,
  );
  absorb(scan, warnings);
  const sessions = Array.isArray(scan?.sessions) ? scan.sessions : [];

  attempt(
    () =>
      mods.claudeCode.linkSessions(sessions, {
        worktreeRoots: [mods.paths.t3WorktreesRoot()],
        threads: t3.threads,
        promptHashes: t3.promptHashes,
      }),
    () => sessions,
    "Linking Claude Code sessions to T3code threads",
    warnings,
  );

  return { sessions };
}

// --- project resolution -------------------------------------------------------------------------

/**
 * Maps a directory to a registry project, inventing an entry when nothing matches.
 *
 * A worktree is the hard case: `~/.t3/worktrees/t3code/<id>` shares no path prefix with the
 * registered `~/Developer/t3code`, so a direct root match fails and the session would look like a
 * brand-new project every time. `canonicalRepo` sees through it — a linked worktree's
 * `--git-common-dir` IS the main checkout's `.git`, so its parent is the registered root.
 */
function createProjectIndex({ mods, registry, run, includeGit, warnings }) {
  const known = new Set(Object.keys(isObject(registry?.projects) ? registry.projects : {}));
  const rows = new Map();
  const dirCache = new Map();
  const repoCache = new Map();
  const rootToKey = new Map();

  function canonical(dir) {
    // With `--no-git` no git process runs at all, so worktree resolution is unavailable and a
    // worktree lands in `unclassified`. That is the honest cost of the flag.
    if (!includeGit) return null;
    if (repoCache.has(dir)) return repoCache.get(dir);
    const repo = attempt(
      () => mods.git.canonicalRepo(dir, run),
      () => null,
      `Resolving the repo for ${dir}`,
      warnings,
    );
    repoCache.set(dir, repo ?? null);
    return repo ?? null;
  }

  function match(dir) {
    if (typeof dir !== "string" || dir.trim() === "") return null;
    return attempt(
      () => mods.registry.matchProjectByRoot(registry, dir),
      () => null,
      "Matching a path against the registry",
      warnings,
    );
  }

  function ensureRow(key, { displayName, roots, isKnown }) {
    let row = rows.get(key);
    if (row === undefined) {
      const classification = attempt(
        () => mods.registry.classify(registry, key),
        () => ({ include: false, visibility: "private", confirmed: false, effective: "excluded" }),
        `Classifying project ${key}`,
        warnings,
      );
      const counted = isKnown
        ? attempt(
            () => mods.registry.isCountable(classification),
            () => true,
            "Reading a classification",
            warnings,
          )
        : // An unclassified project has never been reviewed, so it cannot be named — but the work
          // happened, and dropping it would leave the totals quietly wrong.
          true;
      row = {
        key,
        displayName: displayName ?? key,
        roots: new Set(),
        known: isKnown,
        counted: counted === true,
        classification: {
          include: classification?.include === true,
          visibility:
            typeof classification?.visibility === "string" ? classification.visibility : "private",
          confirmed: classification?.confirmed === true,
          effective:
            typeof classification?.effective === "string" ? classification.effective : "excluded",
          known: isKnown,
          counted: counted === true,
        },
      };
      rows.set(key, row);
    }
    for (const root of roots ?? []) {
      if (typeof root === "string" && root.trim() !== "") row.roots.add(root.trim());
    }
    if (row.displayName === row.key && typeof displayName === "string" && displayName !== "") {
      row.displayName = displayName;
    }
    return row;
  }

  function adoptKnown(key) {
    const entry = isObject(registry?.projects) ? registry.projects[key] : undefined;
    return ensureRow(key, {
      displayName: typeof entry?.displayName === "string" ? entry.displayName : key,
      roots: Array.isArray(entry?.roots) ? entry.roots : [],
      isKnown: true,
    });
  }

  /**
   * The project key owning `dir`. With `invent: false` the answer is null unless the project is
   * already known — that is how a t3code-driven session gets attributed without conjuring a project
   * for the worktree the work merely happened to run in.
   */
  function resolve(dir, hint, { invent = true } = {}) {
    if (typeof dir !== "string" || dir.trim() === "") return null;
    const target = dir.trim();
    if (dirCache.has(target)) return dirCache.get(target);

    let key = match(target);
    let canonicalRoot = target;
    if (key === null) {
      const repo = canonical(target);
      const checkout = mainCheckout(repo);
      if (repo !== null) canonicalRoot = checkout ?? repo.root ?? target;
      key = match(repo?.root) ?? match(checkout);
    }

    if (key !== null) {
      adoptKnown(key);
    } else if (rootToKey.has(canonicalRoot)) {
      // One synthesised key per repo, so ten sessions in one unregistered checkout are one project.
      key = rootToKey.get(canonicalRoot);
      ensureRow(key, { roots: [canonicalRoot], isKnown: false });
    } else if (invent) {
      const displayName = firstNonEmpty(hint, NodePath.basename(canonicalRoot), canonicalRoot);
      key = attempt(
        () => mods.registry.projectKeyFor(displayName, new Set([...known, ...rows.keys()])),
        () => `unknown-${rows.size + 1}`,
        "Naming an unclassified project",
        warnings,
      );
      rootToKey.set(canonicalRoot, key);
      ensureRow(key, { displayName, roots: [canonicalRoot], isKnown: false });
    } else {
      return null;
    }

    dirCache.set(target, key);
    return key;
  }

  // Every registry project the human left enabled is registered up front, whether or not it saw a
  // session: commits happen without a session, and a repo we never look at reports zero forever.
  // `rollUp` only reports the ones that turned out to have activity.
  for (const key of known) {
    const row = adoptKnown(key);
    if (!row.counted) rows.delete(key);
  }

  return { rows, resolve, get: (key) => rows.get(key) ?? null };
}

function mainCheckout(repo) {
  const common = repo?.commonDir;
  if (typeof common !== "string" || common.trim() === "") return null;
  // A bare repo's common dir IS the repo — there is no checkout above it to attribute work to.
  return NodePath.basename(common) === ".git" ? NodePath.dirname(common) : null;
}

// --- sessions -----------------------------------------------------------------------------------

function buildThreadSession({
  mods,
  thread,
  t3,
  window,
  blockOptions,
  nowMs,
  paths,
  projects,
  warnings,
}) {
  const turns = t3.turnsByThread.get(thread.threadId) ?? [];
  const activities = t3.activitiesByThread.get(thread.threadId) ?? [];

  const stamps = [];
  for (const activity of activities) pushStamp(stamps, activity.createdAt, window);
  for (const turn of turns) {
    pushStamp(stamps, turn.requestedAt, window);
    pushStamp(stamps, turn.startedAt, window);
    pushStamp(stamps, turn.completedAt, window);
  }
  pushStamp(stamps, thread.createdAt, window);
  pushStamp(stamps, thread.latestUserMessageAt, window);
  // The thread query matches anything whose lifetime overlaps the window, which includes threads
  // that were merely still open — no in-window event means no work today.
  if (stamps.length === 0) return null;

  // Agent runtime is turn wall-clock, and a turn that stopped to ask a question keeps running while
  // the human is asleep — so the raw span bills hours of waiting as "machine time I directed". Each
  // turn's span is therefore SPLIT around the stretches it spent blocked, and the removed pieces
  // ship as `awaitingInputMs`. Splitting rather than subtracting a scalar is what keeps the
  // per-day clipping in `rollUp` honest: both halves are still intervals.
  const activitiesByTurn = groupBy(activities, (activity) => activity.turnId);
  const spans = [];
  const waitSpans = [];
  for (const turn of turns) {
    const start = toMs(turn.startedAt ?? turn.requestedAt);
    // An unparseable start contributed nothing to the runtime before this change either.
    if (start === null) continue;
    const end = toMs(turn.completedAt);
    const split = splitAroundWaits(
      start,
      end,
      humanWaits(activitiesByTurn.get(turn.turnId) ?? [], start, end),
    );
    spans.push(...split.spans);
    waitSpans.push(...split.waits);
  }

  const project = t3.projects.get(projectRowKey(thread.baseDir, thread.projectId));
  const workspaceRoot = firstNonEmpty(project?.workspaceRoot, thread.worktreePath);
  const projectKey = projects.resolve(workspaceRoot, project?.title ?? null);

  const files = mergeFiles(
    turns.flatMap((turn) => (Array.isArray(turn.files) ? turn.files : [])),
    workspaceRoot,
  );
  const toolEvents = activities.filter((activity) =>
    String(activity.kind ?? "").startsWith("tool"),
  );
  const completedTools = activities.filter((activity) => activity.kind === "tool.completed");
  const taskTitles = dedupe(activities.map((activity) => activity.taskTitle).filter(isText)).slice(
    0,
    MAX_TASK_SIGNALS,
  );

  const signals = [...taskTitles];
  const toolCount = completedTools.length > 0 ? completedTools.length : toolEvents.length;
  if (toolCount > 0) signals.push(`${toolCount} tool ${pluralize(toolCount, "call")}`);
  if (files.length > 0) signals.push(`${files.length} ${pluralize(files.length, "file")} changed`);

  return finishSession({
    key: `t3-${thread.threadId}`,
    kind: "t3code",
    projectKey,
    title: cleanTitle(thread.title) ?? `T3code thread ${shortId(thread.threadId)}`,
    branch: thread.branch ?? null,
    models: Array.isArray(thread.models) ? thread.models : [],
    stamps,
    spans,
    waitSpans,
    turnCount: turns.length,
    files,
    // Checkpoint file lists are a snapshot diff, never a census of what this session edited (§4).
    filesApproximate: true,
    signals,
    tokens:
      attempt(
        () => mods.t3db.tokensByTask(activities),
        () => 0,
        "Totalling T3code tokens",
        warnings,
      ) ?? 0,
    excluded: null,
    // Exact counts for the §8 materiality bar, which lives in lib/extract.mjs. Without these it
    // would have to infer them, and a thread's tool activity has no equivalent to fall back on.
    materiality: {
      turnsWithFiles: turns.filter(
        (turn) => isText(turn.completedAt) && (turn.files?.length ?? 0) > 0,
      ).length,
      toolActivities: toolEvents.length,
      userPrompts: turns.length,
    },
    window,
    blockOptions,
    nowMs,
    paths,
    warnings,
  });
}

function buildClaudeSession({ session, window, blockOptions, nowMs, paths, projects, warnings }) {
  const stamps = [];
  for (const at of session.eventTimes ?? []) pushStamp(stamps, at, window);
  if (stamps.length === 0) return null;

  const spans = (Array.isArray(session.turnSpans) ? session.turnSpans : []).map((span) => ({
    start: span?.start ?? null,
    end: span?.end ?? null,
  }));

  const excluded = normaliseExclusion(session);
  // A t3code-driven session is attributed to whatever project already owns its cwd, but it never
  // invents one: the work is already counted under the T3code thread that drove it, and its cwd is
  // usually a throwaway worktree that would otherwise show up as a brand-new project every day.
  const projectKey = projects.resolve(session.cwd, null, { invent: excluded === null });

  const signals = [];
  if (session.toolUseCount > 0) {
    signals.push(`${session.toolUseCount} tool ${pluralize(session.toolUseCount, "turn")}`);
  }
  for (const link of session.prLinks ?? []) {
    if (Number.isSafeInteger(link?.number)) signals.push(`PR #${link.number}`);
  }
  for (const version of session.versions ?? []) signals.push(`claude-code ${version}`);

  return finishSession({
    key: `cc-${session.sessionId}`,
    kind: "claude-code",
    projectKey,
    title:
      cleanTitle(session.firstPrompt ?? session.lastPrompt) ??
      `Claude Code session ${shortId(session.sessionId)}`,
    branch: session.gitBranch ?? null,
    models: Array.isArray(session.models) ? session.models : [],
    stamps,
    spans,
    // A Claude Code span already ends at the last record before the next prompt, so the time the
    // human spent thinking between prompts was never inside it. There is nothing to subtract.
    waitSpans: [],
    turnCount: session.promptCount ?? 0,
    // The transcript is the only prose a standalone Claude Code session has: there are no `summary`
    // records in this user's history, so `lib/extract.mjs` builds its slice out of exactly these
    // two fields. Dropping them left every terminal-only day with a prompt-less slice.
    firstPrompt: clampPrompt(session.firstPrompt),
    lastPrompt: clampPrompt(session.lastPrompt),
    files: [],
    filesApproximate: false,
    signals,
    tokens: 0,
    excluded,
    materiality: {
      turnsWithFiles: 0,
      toolActivities: countOf(session.toolUseCount),
      userPrompts: countOf(session.promptCount),
    },
    window,
    blockOptions,
    nowMs,
    paths,
    warnings,
  });
}

// A subagent's own transcript is not a session the human ran; counting it would inflate the day.
function normaliseExclusion(session) {
  const excluded = session?.excluded;
  if (isObject(excluded)) {
    return {
      reason: isText(excluded.reason) ? excluded.reason : "t3code-driven",
      rule: isText(excluded.rule) ? excluded.rule : null,
      linkedTo: isText(excluded.linkedTo) ? excluded.linkedTo : null,
    };
  }
  if (session?.sidechainOnly === true) {
    return { reason: "sidechain-only", rule: "sidechain", linkedTo: null };
  }
  return null;
}

function finishSession({
  key,
  kind,
  projectKey,
  title,
  branch,
  models,
  stamps,
  spans,
  waitSpans = [],
  turnCount,
  firstPrompt = null,
  lastPrompt = null,
  files,
  filesApproximate = false,
  signals,
  tokens,
  excluded,
  materiality,
  window,
  blockOptions,
  nowMs,
  paths,
  warnings,
}) {
  const timeline = activeTimeline(stamps, blockOptions);
  const cached = readExtract(paths, key, window, warnings);

  const session = {
    key,
    kind,
    projectKey: projectKey ?? null,
    title,
    branch: branch ?? null,
    models,
    startedAt: toIso(Math.min(...stamps)),
    endedAt: toIso(Math.max(...stamps)),
    turnCount,
    // Null on a T3code session on purpose: a thread's prose lives in `projection_thread_messages`,
    // which `lib/extract.mjs` reads from the database itself rather than through the bundle.
    firstPrompt,
    lastPrompt,
    agentRuntimeMs: spanMs(spans, window, { now: nowMs }),
    awaitingInputMs: spanMs(waitSpans, window, { now: nowMs }),
    activeMs: timeline.activeMs,
    files,
    filesApproximate,
    signals,
    tokens: Number.isFinite(tokens) ? tokens : 0,
    materiality,
    extract: cached.extract,
    withheldExtract: cached.withheld,
    needsExtraction: false,
    excluded,
  };

  // The §8 decision — cursor, materiality bar and the "already told by its T3code thread" rule —
  // belongs to lib/extract.mjs, which also owns the file format. Asking it here is what keeps the
  // queue the collector advertises identical to the one `worklog extract-queue` actually builds.
  // It is asked with the ON-DISK extract, not the one the bundle publishes: `queue()` re-reads the
  // file itself, so answering from a withheld extract would advertise a queue nobody would build.
  const verdict = attempt(
    () => needsExtractionOf(session, cached.onDisk),
    () => ({ needed: false }),
    `Deciding whether ${key} needs extraction`,
    warnings,
  );
  session.needsExtraction = verdict?.needed === true;

  return {
    session,
    counted: excluded === null,
    projectKey: projectKey ?? null,
    stamps,
    spans,
    waitSpans,
    dayKey: dayOf(Math.min(...stamps), window),
  };
}

/**
 * The stored extract for a session as `{ onDisk, extract, withheld }`. `loadExtract` treats an
 * unusable file as absent — the safe reading, since one wasted extraction beats trusting a cursor
 * we cannot parse — but it does so silently, and a file that exists yet will not load is worth
 * saying out loud.
 *
 * `extract` is the one the bundle publishes and is null unless the file is demonstrably ABOUT this
 * window. An extract is per session, not per day: run `/worklog` for today and then for yesterday
 * and the session's one extract — written about today — would otherwise be attached under
 * yesterday's date, putting the wrong day's work in a dated report.
 *
 * It is WITHHELD rather than flagged because a flag only helps a reader that checks it, and every
 * renderer downstream would have to opt in; a null cannot be misread. `onDisk` is kept so the
 * cursor still drives `needsExtraction`.
 */
function readExtract(paths, key, window, warnings) {
  const onDisk = attempt(
    () => loadExtract(paths, key),
    () => null,
    `Reading the extract for ${key}`,
    warnings,
  );
  if (onDisk === null) {
    const file = attempt(
      () => extractPath(paths, key),
      () => "",
      `Locating the extract for ${key}`,
      warnings,
    );
    if (file !== "" && NodeFS.existsSync(file)) {
      warnings.push(
        `The extract at ${file} is unreadable or empty; ${key} will be extracted again.`,
      );
    }
    return { onDisk: null, extract: null, withheld: null };
  }

  // The cursor is the newest event the extract summarised, so it is the one field that says which
  // work the prose is about.
  const cursorAt = onDisk.cursor?.lastEventAt ?? null;
  const cursorMs = toMs(cursorAt);
  if (cursorMs === null) {
    return {
      onDisk,
      extract: null,
      withheld: { cursorAt: null, reason: "its cursor records no event time" },
    };
  }
  if (cursorMs >= window.end) {
    return {
      onDisk,
      extract: null,
      withheld: { cursorAt, reason: `it summarises work through ${cursorAt}, after this window` },
    };
  }
  if (cursorMs < window.start) {
    return {
      onDisk,
      extract: null,
      withheld: { cursorAt, reason: `it summarises work through ${cursorAt}, before this window` },
    };
  }
  return { onDisk, extract: onDisk, withheld: null };
}

/**
 * Human-wait intervals inside ONE turn, clamped to that turn's own span. A `null` end means the
 * turn is still blocked; `splitAroundWaits` turns that into "nothing ran after this point".
 *
 * Pairing is positional, not by `payload.requestId`: `readActivities` deliberately does not surface
 * the request id, and across every turn in the real store the two kinds strictly alternate (a turn
 * can only have one question outstanding), so "the next resolve closes the open request" IS the id
 * pairing. Two rules were checked against real data rather than guessed:
 *
 *   * A request with no resolve stays open to the end of the turn. During a wait the only activity
 *     a turn emits is a single `context-window.updated` a few ms later — there is never evidence of
 *     the agent resuming — so an unanswered question really did block the turn until it ended or
 *     was interrupted (three such turns sat blocked ~12 h before the human interrupted them).
 *   * A resolve with nothing open answers a question asked BEFORE the window, whose `requested` row
 *     the window query never returned. It opens at the end of the previous wait (the turn's start,
 *     the first time), which can only ever reach back to material the window already clips off.
 */
function humanWaits(activities, spanStart, spanEnd) {
  const waits = [];
  const limit = spanEnd === null ? OPEN_END : spanEnd;
  let openAt = null;
  let floor = spanStart;

  for (const activity of activities) {
    const kind = activity?.kind;
    if (kind !== INPUT_REQUESTED && kind !== INPUT_RESOLVED) continue;
    const at = toMs(activity.createdAt);
    if (at === null) continue;
    if (kind === INPUT_REQUESTED) {
      if (openAt === null) openAt = clamp(at, floor, limit);
      continue;
    }
    const start = openAt ?? floor;
    const end = clamp(at, start, limit);
    if (end > start) waits.push({ start, end });
    // Never rewind past a wait already closed, so a duplicated resolve is a no-op rather than a
    // second subtraction of the same minutes.
    floor = end;
    openAt = null;
  }

  if (openAt !== null) waits.push({ start: openAt, end: spanEnd });
  return waits;
}

/**
 * Splits `[start, end]` around `waits`, returning the pieces that actually ran and the pieces spent
 * waiting. `end === null` means "still running" and survives onto whichever piece ends the turn —
 * `lib/timeline.mjs` closes that at `min(window end, now)`, which the window end alone is not.
 */
function splitAroundWaits(start, end, waits) {
  const limit = end === null ? OPEN_END : end;
  const blocked = [];
  for (const wait of waits) {
    const from = clamp(wait.start, start, limit);
    const to = clamp(wait.end === null ? limit : wait.end, from, limit);
    if (to > from) blocked.push({ start: from, end: to });
  }
  blocked.sort((left, right) => left.start - right.start || left.end - right.end);

  const merged = [];
  for (const wait of blocked) {
    const last = merged.at(-1);
    if (last !== undefined && wait.start <= last.end) {
      if (wait.end > last.end) last.end = wait.end;
      continue;
    }
    merged.push({ ...wait });
  }

  const spans = [];
  let cursor = start;
  for (const wait of merged) {
    if (wait.start > cursor) spans.push(spanOf(cursor, wait.start));
    cursor = Math.max(cursor, wait.end);
  }
  if (cursor < limit) spans.push(spanOf(cursor, limit));
  return { spans, waits: merged.map((wait) => spanOf(wait.start, wait.end)) };
}

function spanOf(start, end) {
  return { start, end: end === OPEN_END ? null : end };
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// --- git ----------------------------------------------------------------------------------------

function collectRepos({ mods, projects, window, identities, warnings }) {
  const dirs = [];
  const owners = new Map();
  for (const row of projects.rows.values()) {
    if (!row.counted) continue;
    for (const root of row.roots) {
      const resolved = attempt(
        () => mods.paths.expandHome(root),
        () => root,
        "Resolving a project root",
        warnings,
      );
      if (!isText(resolved) || owners.has(resolved)) continue;
      owners.set(resolved, row.key);
      dirs.push(resolved);
    }
  }
  if (dirs.length === 0) return { repos: [] };

  const collected = attempt(
    () =>
      mods.git.collectGit(
        dirs,
        { start: window.start, end: window.end, identities },
        { run: mods.run },
      ),
    () => ({ repos: [], warnings: [] }),
    "Collecting git history",
    warnings,
  );
  absorb(collected, warnings);

  const repos = [];
  for (const repo of Array.isArray(collected?.repos) ? collected.repos : []) {
    if (!isObject(repo)) continue;
    const root = isText(repo.root) ? repo.root : "";
    const projectKey =
      owners.get(root) ??
      containingOwner(mods, owners, root, warnings) ??
      projects.resolve(root, null);
    repos.push({
      key: isText(repo.key) ? repo.key : root,
      root,
      nameWithOwner: isText(repo.nameWithOwner) ? repo.nameWithOwner : null,
      projectKey: projectKey ?? null,
      commits: Array.isArray(repo.commits) ? repo.commits : [],
      mergedPrs: Array.isArray(repo.mergedPrs) ? repo.mergedPrs : [],
      warnings: Array.isArray(repo.warnings) ? repo.warnings : [],
    });
  }
  return { repos };
}

// `canonicalRepo` reports the toplevel, which can sit above or below the root the registry lists
// (a registry root of `repo/apps/server`, or a worktree resolved back to its main checkout).
function containingOwner(mods, owners, root, warnings) {
  if (!isText(root)) return null;
  for (const [dir, key] of owners) {
    const related = attempt(
      () => mods.paths.isUnder(dir, root) || mods.paths.isUnder(root, dir),
      () => false,
      "Comparing repository roots",
      warnings,
    );
    if (related === true) return key;
  }
  return null;
}

// --- rollups ------------------------------------------------------------------------------------

function rollUp({ contributions, git, projects, range, window, blockOptions, nowMs }) {
  const perProject = new Map();
  const perDay = new Map();
  for (const day of range.days) perDay.set(day, newDayBucket());

  const mergedStamps = [];
  const totals = newStats();
  const totalFiles = new Set();
  const allSpans = [];
  const allWaitSpans = [];
  let filesApproximate = false;

  const bucketFor = (key) => {
    const row = projects.get(key);
    if (row === null || row === undefined) return null;
    let bucket = perProject.get(key);
    if (bucket === undefined) {
      bucket = { row, stats: newStats(), files: new Set(), stamps: [], spans: [], waitSpans: [] };
      perProject.set(key, bucket);
    }
    return bucket;
  };

  // A timestamp the collector could not place still happened inside the window — git and the
  // scanners both filtered on it — so it is charged to the first day rather than dropped, which
  // would leave the per-day numbers quietly short of the range totals.
  const dayBucket = (dayKey) => perDay.get(dayKey) ?? perDay.get(range.days[0]);

  for (const contribution of contributions) {
    const { session } = contribution;
    const project = projects.get(contribution.projectKey);
    // Every project a session points at is reported, even at zero, so no session in the bundle
    // references a project the reader cannot look up.
    const bucket = bucketFor(contribution.projectKey);
    // An excluded session is evidence, not work; a project the human switched off is not counted.
    // A session whose project could not be resolved at all (a transcript with no cwd) still counts:
    // it belongs to no bucket, but dropping it would understate the day.
    if (!contribution.counted) continue;
    if (project !== null && project !== undefined && !project.counted) continue;

    const day = dayBucket(contribution.dayKey);

    mergedStamps.push(...contribution.stamps);
    allSpans.push(...contribution.spans);
    allWaitSpans.push(...contribution.waitSpans);
    if (bucket !== null) {
      bucket.stamps.push(...contribution.stamps);
      bucket.spans.push(...contribution.spans);
      bucket.waitSpans.push(...contribution.waitSpans);
      bucket.stats.sessions += 1;
      bucket.stats.turns += session.turnCount;
      bucket.stats.tokens += session.tokens;
    }
    totals.sessions += 1;
    totals.turns += session.turnCount;
    totals.tokens += session.tokens;

    if (day !== undefined) {
      day.stats.sessions += 1;
      day.stats.turns += session.turnCount;
      day.stats.tokens += session.tokens;
      day.sessionKeys.push(session.key);
    }

    // Only a session that actually contributed paths can qualify `filesTouched`.
    if (session.filesApproximate === true && session.files.length > 0) filesApproximate = true;
    for (const file of session.files) {
      totalFiles.add(file.path);
      bucket?.files.add(file.path);
      day?.files.add(file.path);
    }
  }

  for (const repo of git.repos) {
    const row = repo.projectKey === null ? null : projects.get(repo.projectKey);
    if (row !== null && row !== undefined && !row.counted) continue;
    // A repo with nothing in the window must not conjure a project row for a registry entry that
    // simply had a quiet day.
    const hasWork = repo.commits.length > 0 || repo.mergedPrs.length > 0;
    const bucket = hasWork && repo.projectKey !== null ? bucketFor(repo.projectKey) : null;

    for (const commit of repo.commits) {
      const day = dayBucket(dayOf(toMs(commit?.at), window));
      const insertions = countOf(commit?.insertions);
      const deletions = countOf(commit?.deletions);
      totals.commits += 1;
      totals.linesAdded += insertions;
      totals.linesRemoved += deletions;
      if (bucket !== null) {
        bucket.stats.commits += 1;
        bucket.stats.linesAdded += insertions;
        bucket.stats.linesRemoved += deletions;
      }
      if (day !== undefined) {
        day.stats.commits += 1;
        day.stats.linesAdded += insertions;
        day.stats.linesRemoved += deletions;
        day.repoKeys.add(repo.key);
      }
    }

    for (const pr of repo.mergedPrs) {
      const day = dayBucket(dayOf(toMs(pr?.mergedAt), window));
      totals.prsMerged += 1;
      if (bucket !== null) bucket.stats.prsMerged += 1;
      if (day !== undefined) {
        day.stats.prsMerged += 1;
        day.repoKeys.add(repo.key);
      }
    }
  }

  const merged = activeTimeline(mergedStamps, blockOptions);
  totals.activeMs = merged.activeMs;
  totals.agentRuntimeMs = spanMs(allSpans, window, { now: nowMs });
  totals.awaitingInputMs = spanMs(allWaitSpans, window, { now: nowMs });
  totals.filesTouched = totalFiles.size;

  // Durations are CLIPPED into each day rather than attributed to one, and the days partition the
  // window, so both of these sum back to the range totals however many midnights a session crossed.
  const dayBlocks = splitByDay(merged.blocks, range.days);
  for (const [day, bucket] of perDay) {
    bucket.stats.filesTouched = bucket.files.size;
    bucket.stats.activeMs = sumMs(dayBlocks.get(day));
    bucket.stats.agentRuntimeMs = spanMs(allSpans, dayWindowOf(day), { now: nowMs });
    bucket.stats.awaitingInputMs = spanMs(allWaitSpans, dayWindowOf(day), { now: nowMs });
  }

  const projectsOut = [];
  for (const bucket of perProject.values()) {
    const timeline = activeTimeline(bucket.stamps, blockOptions);
    bucket.stats.activeMs = timeline.activeMs;
    bucket.stats.agentRuntimeMs = spanMs(bucket.spans, window, { now: nowMs });
    bucket.stats.awaitingInputMs = spanMs(bucket.waitSpans, window, { now: nowMs });
    bucket.stats.filesTouched = bucket.files.size;
    projectsOut.push({
      key: bucket.row.key,
      displayName: bucket.row.displayName,
      roots: [...bucket.row.roots].sort(),
      classification: bucket.row.classification,
      stats: bucket.stats,
    });
  }
  projectsOut.sort(
    (left, right) =>
      right.stats.activeMs - left.stats.activeMs ||
      right.stats.sessions - left.stats.sessions ||
      left.key.localeCompare(right.key),
  );

  totals.projectsTouched = projectsOut.filter(
    (project) =>
      project.stats.sessions > 0 || project.stats.commits > 0 || project.stats.prsMerged > 0,
  ).length;

  const unclassified = projectsOut
    .filter((project) => !project.classification.known)
    .filter((project) => project.stats.sessions > 0 || project.stats.commits > 0)
    .map((project) => ({
      key: project.key,
      displayName: project.displayName,
      roots: project.roots,
      evidence: {
        sessions: project.stats.sessions,
        commits: project.stats.commits,
        activeMs: project.stats.activeMs,
      },
    }));

  const byDay = {};
  for (const [day, bucket] of perDay) {
    byDay[day] = {
      ...bucket.stats,
      sessionKeys: bucket.sessionKeys,
      repoKeys: [...bucket.repoKeys],
    };
  }

  return {
    projects: projectsOut,
    unclassified,
    stats: {
      projectsTouched: totals.projectsTouched,
      sessions: totals.sessions,
      turns: totals.turns,
      commits: totals.commits,
      prsMerged: totals.prsMerged,
      filesTouched: totals.filesTouched,
      linesAdded: totals.linesAdded,
      linesRemoved: totals.linesRemoved,
      tokens: totals.tokens,
      activeMs: totals.activeMs,
      agentRuntimeMs: totals.agentRuntimeMs,
      awaitingInputMs: totals.awaitingInputMs,
      // Every `filesTouched` in this bundle — range, per project, per day — is an upper bound when
      // this is true. Upstream derives a turn's file list by diffing workspace SNAPSHOTS
      // (apps/server/src/orchestration/Layers/CheckpointReactor.ts), so a branch switch, a `git
      // pull` or a rebase landing between turns is indistinguishable from work the session did.
      // The stored diff carries no provenance, so this cannot be corrected — only declared.
      filesTouchedApproximate: filesApproximate,
      activeBlocks: merged.blocks,
    },
    byDay,
  };
}

function newStats() {
  return {
    sessions: 0,
    turns: 0,
    commits: 0,
    prsMerged: 0,
    filesTouched: 0,
    linesAdded: 0,
    linesRemoved: 0,
    tokens: 0,
    activeMs: 0,
    agentRuntimeMs: 0,
    awaitingInputMs: 0,
  };
}

// `filesTouched` is the one field that cannot sum across days: it is a distinct count, so a file
// edited on both days is one file in the range total and one in each day.
function newDayBucket() {
  return { stats: newStats(), files: new Set(), sessionKeys: [], repoKeys: new Set() };
}

// --- helpers ------------------------------------------------------------------------------------

function resolveDeps(deps) {
  const source = isObject(deps) ? deps : {};
  const git = { ...DefaultGit, ...(isObject(source.git) ? source.git : {}) };
  return {
    t3db: { ...DefaultT3Db, ...(isObject(source.t3db) ? source.t3db : {}) },
    claudeCode: { ...DefaultClaudeCode, ...(isObject(source.claudeCode) ? source.claudeCode : {}) },
    git,
    registry: { ...DefaultRegistry, ...(isObject(source.registry) ? source.registry : {}) },
    paths: { ...DefaultPaths, ...(isObject(source.paths) ? source.paths : {}) },
    run: typeof source.run === "function" ? source.run : git.createRunner(),
  };
}

function attempt(fn, fallback, label, warnings) {
  try {
    return fn();
  } catch (error) {
    warnings.push(`${label} failed: ${messageOf(error)}`);
    return fallback();
  }
}

async function attemptAsync(fn, fallback, label, warnings) {
  try {
    return await fn();
  } catch (error) {
    warnings.push(`${label} failed: ${messageOf(error)}`);
    return fallback();
  }
}

// The t3db readers hang their diagnostics off the returned array as a non-enumerable `warnings`.
function read(fn, fallback, label, warnings) {
  const result = attempt(fn, () => fallback, label, warnings);
  absorb(result, warnings);
  return result ?? fallback;
}

function absorb(result, warnings) {
  const list = result?.warnings;
  if (!Array.isArray(list)) return result;
  for (const warning of list) {
    if (isText(warning)) warnings.push(warning);
  }
  return result;
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = keyOf(row);
    if (!isText(key)) continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }
  return groups;
}

function projectRowKey(baseDir, projectId) {
  // Two state directories can hold the same project id; NUL cannot appear in either half.
  return `${baseDir ?? ""}\u0000${projectId ?? ""}`;
}

function pushStamp(list, value, window) {
  const ms = toMs(value);
  // Half-open, matching every other day boundary in the collector.
  if (ms === null || ms < window.start || ms >= window.end) return;
  list.push(ms);
}

function dayOf(ms, window) {
  if (!Number.isFinite(ms)) return null;
  // An event that started before the window still belongs to a day IN it, or the per-day numbers
  // would not add up to the range totals.
  const clamped = Math.min(Math.max(ms, window.start), window.end - 1);
  return localDayKey(clamped);
}

function dayWindowOf(dayKey) {
  const parts = String(dayKey).split("-").map(Number);
  const start = new Date(parts[0], parts[1] - 1, parts[2]);
  const end = new Date(parts[0], parts[1] - 1, parts[2] + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function sumMs(pieces) {
  let total = 0;
  for (const piece of Array.isArray(pieces) ? pieces : []) {
    const ms = Number(piece?.ms);
    if (Number.isFinite(ms) && ms > 0) total += ms;
  }
  return total;
}

/**
 * Sums churn per path. Checkpoint paths are already repo-relative; absolute ones are reduced.
 *
 * The input is a per-turn diff of workspace SNAPSHOTS, so summing it inflates both the file count
 * and the per-file churn by whatever else touched the tree between two turns. Nothing in the stored
 * payload distinguishes the two, so the totals travel flagged (`filesApproximate`) rather than
 * cleaned — see `stats.filesTouchedApproximate`.
 */
function mergeFiles(files, root) {
  const byPath = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const raw = isText(file?.path) ? file.path.trim() : "";
    if (raw === "") continue;
    const path = NodePath.isAbsolute(raw) ? DefaultPaths.repoRelative(root ?? "", raw) : raw;
    if (path === "") continue;
    const existing = byPath.get(path);
    if (existing === undefined) {
      byPath.set(path, {
        path,
        additions: countOf(file.additions),
        deletions: countOf(file.deletions),
      });
      continue;
    }
    existing.additions += countOf(file.additions);
    existing.deletions += countOf(file.deletions);
  }
  return [...byPath.values()].sort(
    (left, right) =>
      right.additions + right.deletions - (left.additions + left.deletions) ||
      left.path.localeCompare(right.path),
  );
}

function cleanTitle(text) {
  if (!isText(text)) return null;
  const firstLine = text.split("\n").find((line) => line.trim() !== "");
  if (firstLine === undefined) return null;
  const collapsed = firstLine.trim().replace(/\s+/gu, " ");
  if (collapsed === "") return null;
  return collapsed.length <= TITLE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

/** Prompt text as the bundle carries it: whole (newlines and all), just never unbounded. */
function clampPrompt(text) {
  if (!isText(text)) return null;
  return text.length <= PROMPT_MAX_CHARS ? text : `${text.slice(0, PROMPT_MAX_CHARS - 1)}…`;
}

function shortId(id) {
  return isText(id) ? id.slice(0, 8) : "unknown";
}

function dayArg(value, fallback) {
  return isText(value) && value.trim() !== "" ? value.trim() : fallback;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function countOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (isText(value) && value.trim() !== "") return value.trim();
  }
  return null;
}

function dedupe(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
