// The incremental extraction cache — the reason a second /worklog run over the same day is free.
//
// One invariant justifies every line below: NO MESSAGE IS EVER READ TWICE. Each session owns one
// extract file holding a read cursor, and a session is only handed to a model when it has events
// strictly newer than that cursor *and* enough substance to be worth the tokens. Re-running a day
// that has already been extracted queues nothing, writes nothing, and costs nothing.
//
// The other half of the job is the slice: the only text from a session that ever reaches a model.
// It carries prompts, assistant text, tool `detail` lines, file basenames and commit subjects —
// never a tool result, and never a string that has not been through `redactSlice`. Tool output is
// where secrets, file contents and command stdout live, so the safe list here is a whitelist: a
// field that is not read on purpose cannot leak by accident.
//
// Everything is read-only toward the user's data. The only writes are inside the worklog repo:
// the slices under `.worklog-tmp/slices/`, and the extract files under `extracts/`.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseIso, rangeWindow, toIso } from "./format.mjs";
import { safeKey, worklogPaths } from "./paths.mjs";
import { basenameOnly, redactSlice } from "./redact.mjs";
import { closeDatabases, openT3Databases, readActivities, readThreadMessages } from "./t3db.mjs";

/** Bump only for a breaking change to the extract file shape; an unknown version is re-extracted. */
export const EXTRACT_SCHEMA_VERSION = 1;

// --- slice budget ---------------------------------------------------------------------------

// ~12 000 chars is roughly 3k tokens: enough for a Haiku subagent to see the shape of a session,
// small enough that queueing eight of them is still cheap.
const SLICE_MAX_CHARS = 12_000;
const PROMPT_MAX_CHARS = 1200;
const ASSISTANT_MAX_CHARS = 800;
const ACTIVITY_MAX_CHARS = 200;
const MAX_PROMPTS = 12;
const MAX_ACTIVITY_LINES = 40;
const MAX_FILES = 30;
// Not in the contract, but an unbounded section would defeat the cap by starving the ones above it.
const MAX_COMMITS = 30;

// A commit is very often the first thing that happens after a session's last recorded event — the
// work ends, then it is committed — so the session's own window gets a short tail. Short on
// purpose: widen it and the next session's commits come back as this one's evidence.
const COMMIT_GRACE_MS = 10 * 60_000;

const DEFAULT_QUEUE_LIMIT = 8;

// --- materiality ----------------------------------------------------------------------------

// A session below all three bars is a stray question or an aborted start: real to the timeline,
// worthless to a narrative, and not worth a model call.
const MATERIAL_TOOL_ACTIVITIES = 3;
const MATERIAL_USER_PROMPTS = 2;

// --- extract payload ------------------------------------------------------------------------

const EXTRACT_FIELDS = ["problem", "approach", "outcome"];
const FIELD_MAX_CHARS = 600;
const MAX_ARTIFACTS = 12;
const MAX_HISTORY = 20;
const STATUSES = ["shipped", "in-progress", "blocked", "abandoned", "exploration"];

// A relative path of three or more segments is a location, not prose. One- and two-segment tokens
// are left alone so `owner/repo` and `feat/my-branch` survive. Absolute and `~` paths are already
// reduced by `redactSlice`; the leading lookbehind keeps this off the tail of a URL.
const DEEP_RELATIVE_PATH = /(?<![\w@#:/~.-])(?:\.{1,2}\/)?(?:[\w.@+~-]+\/){2,}[\w.@+-]*/gu;

const FENCED_BLOCK =
  /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*(?:`{3,}|~{3,})|$)/gu;

/** Absolute path of a session's extract file: `<root>/extracts/<safeKey>.json`. */
export function extractPath(paths, sessionKey) {
  return NodePath.join(resolvePaths(paths).extracts, `${safeKey(sessionKey)}.json`);
}

/** The stored extract for a session, or null when it is missing, unreadable, or corrupt. */
export function loadExtract(paths, sessionKey) {
  let text;
  try {
    text = NodeFS.readFileSync(extractPath(paths, sessionKey), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A half-written or hand-edited file reads as "never extracted": one wasted extraction is a
    // far better failure than a cursor we cannot trust.
    return null;
  }
  return normaliseDocument(parsed, sessionKey);
}

/** Loads many extracts at once; keys with no usable file are simply absent from the map. */
export function loadExtracts(paths, sessionKeys) {
  const map = new Map();
  for (const key of Array.isArray(sessionKeys) ? sessionKeys : []) {
    const sessionKey = asText(key).trim();
    if (sessionKey === "" || map.has(sessionKey)) continue;
    const extract = loadExtract(paths, sessionKey);
    if (extract !== null) map.set(sessionKey, extract);
  }
  return map;
}

/**
 * Whether a session has new material worth a model call, and the reason either way (the reason is
 * what lets the run summary explain a skip instead of silently dropping the session).
 */
export function needsExtraction(session, extract) {
  if (!isPlainObject(session)) return { needed: false, reason: "not a session", newEvents: 0 };

  // A T3code-driven Claude Code session is the same work as its thread; extracting both would pay
  // twice for one story.
  if (isPlainObject(session.excluded)) {
    const why = asText(session.excluded.reason).trim() || "excluded";
    return { needed: false, reason: `excluded (${why})`, newEvents: 0 };
  }

  const lastEventMs = lastEventMsOf(session);
  if (lastEventMs === null) {
    return { needed: false, reason: "no timestamped events", newEvents: 0 };
  }

  const cursorIso = isPlainObject(extract?.cursor) ? asText(extract.cursor.lastEventAt) : "";
  const cursorMs = parseIso(cursorIso);
  if (cursorMs !== null && lastEventMs <= cursorMs) {
    return { needed: false, reason: `already extracted through ${cursorIso}`, newEvents: 0 };
  }

  const materiality = materialityOf(session);
  if (!materiality.material) {
    return {
      needed: false,
      reason: `below the materiality bar (${materiality.summary})`,
      newEvents: 0,
    };
  }

  const newEvents = countNewEvents(session, cursorMs);
  const reason =
    cursorMs === null
      ? `first extraction (${materiality.summary})`
      : `${newEvents} new ${newEvents === 1 ? "event" : "events"} since ${cursorIso}`;
  return { needed: true, reason, newEvents };
}

/**
 * Renders the one text a subagent is allowed to see for a session: prompts, assistant text, tool
 * `detail` lines, file basenames, commit subjects — redacted, deduped, and hard-capped.
 */
export function buildSlice(session, options = {}) {
  try {
    const opts = isPlainObject(options) ? options : {};
    const scrubOptions = { homeDir: opts.homeDir, redaction: opts.redaction };
    const scrub = (value) => redactSlice(asText(value), scrubOptions);
    const maxChars = positiveInt(opts.maxChars) ?? SLICE_MAX_CHARS;

    const messages = arrayOf(opts.messages ?? session?.messages);
    const activities = arrayOf(opts.activities ?? session?.activities);
    const commits = arrayOf(opts.commits ?? session?.commits);
    const files = arrayOf(opts.files ?? session?.files);

    const sections = [
      { name: "Session", pinned: true, lines: sessionLines(session, scrub) },
      { name: "Prompts", pinned: true, lines: promptLines(session, messages, scrub) },
      { name: "Assistant", pinned: false, lines: assistantLines(messages, scrub) },
      { name: "Activity", pinned: false, lines: activityLines(activities, scrub) },
      { name: "Files", pinned: false, lines: fileLines(files, scrub) },
      { name: "Commits", pinned: false, lines: commitLines(commits, scrub) },
    ].filter((section) => section.lines.length > 0);

    const kept = [...sections];
    const dropped = [];
    let text = renderSections(kept, dropped, scrubOptions);
    while (text.length > maxChars) {
      // Bottom-up: the sections nearest the end are the ones a narrative can most easily do
      // without, and the git evidence they hold is already in the bundle.
      const index = findLastIndex(kept, (section) => !section.pinned);
      if (index === -1) break;
      dropped.push(kept[index].name);
      kept.splice(index, 1);
      text = renderSections(kept, dropped, scrubOptions);
    }
    return text.length > maxChars ? hardTruncate(text, maxChars) : text;
  } catch {
    // A slice that cannot be built safely must not fall back to raw text.
    return "[worklog: slice unavailable]";
  }
}

/**
 * Picks the sessions worth extracting, writes their slices, and reports what was skipped and why.
 * `deps.loadInput(session, { afterIso, extract })` supplies the new messages/activities/commits and
 * must be synchronous; anything it cannot provide falls back to what the session already carries.
 */
export function queue({ bundle, paths, limit = DEFAULT_QUEUE_LIMIT, deps = {}, ...rest } = {}) {
  const warnings = [];
  const queued = [];
  const skipped = [];

  const injected = isPlainObject(deps) ? deps : {};
  const resolved = resolvePaths(paths ?? bundle?.config?.worklogRoot);
  const cap = positiveInt(limit) ?? DEFAULT_QUEUE_LIMIT;
  // The redaction list only ever arrives from the caller. There is deliberately no fallback to a
  // field on the bundle: `collect()` emits none, and the one that used to be read here (`bundle
  // .redaction`) meant the always-redact terms were silently applied to exactly zero real slices.
  const sliceOptions = {
    homeDir: rest.homeDir ?? injected.homeDir,
    redaction: rest.redaction ?? injected.redaction,
    maxChars: rest.maxChars ?? injected.maxChars,
  };

  if (!isPlainObject(bundle)) {
    warnings.push("No evidence bundle was supplied, so nothing could be queued.");
    return { queued, skipped, warnings };
  }
  const sessions = arrayOf(bundle.sessions).filter(isPlainObject);
  if (sessions.length === 0) warnings.push("The evidence bundle contains no sessions.");

  // An injected loader wins (that is how the tests drive this); otherwise the real one is built.
  const defaultLoad =
    typeof injected.loadInput === "function" ? null : createDefaultLoadInput(bundle, warnings);
  const loaders = defaultLoad === null ? injected : { ...injected, loadInput: defaultLoad };

  const candidates = [];
  for (const session of sessions) {
    const sessionKey = asText(session.key ?? session.sessionKey).trim();
    if (sessionKey === "") {
      warnings.push("Skipped a session with no key.");
      continue;
    }
    // The file on disk is the authority: a stale `extract` copied into the bundle must never be
    // able to re-open a cursor that has already advanced.
    const extract =
      loadExtract(resolved, sessionKey) ??
      (isPlainObject(session.extract) ? session.extract : null);
    const decision = needsExtraction(session, extract);
    if (!decision.needed) {
      skipped.push({ ...identityOf(session, sessionKey), reason: decision.reason });
      continue;
    }
    candidates.push({ session, sessionKey, extract, decision });
  }

  candidates.sort(byMaterialValue);

  for (const candidate of candidates) {
    const identity = identityOf(candidate.session, candidate.sessionKey);
    if (queued.length >= cap) {
      skipped.push({ ...identity, reason: `over the per-run limit of ${cap}` });
      continue;
    }

    const input = loadInput(loaders, candidate, warnings);
    const slice = buildSlice(candidate.session, { ...sliceOptions, ...input });
    const slicePath = NodePath.join(resolved.slices, `${safeKey(candidate.sessionKey)}.md`);
    try {
      NodeFS.mkdirSync(NodePath.dirname(slicePath), { recursive: true });
      NodeFS.writeFileSync(slicePath, slice.endsWith("\n") ? slice : `${slice}\n`, "utf8");
    } catch (error) {
      warnings.push(
        `Could not write the slice for ${candidate.sessionKey}: ${errorMessage(error)}`,
      );
      skipped.push({ ...identity, reason: "the slice could not be written" });
      continue;
    }

    queued.push({
      ...identity,
      slicePath,
      reason: candidate.decision.reason,
      newEvents: candidate.decision.newEvents ?? 0,
    });
  }

  // Read-only handles, but leaving them open would hold a file descriptor on a 700 MB database for
  // the rest of the process.
  if (typeof defaultLoad?.close === "function") defaultLoad.close();

  // Said out loud on purpose: a caller that forgets to pass the list gets slices with only the
  // built-in path/secret scrubbing, and the last time that happened nothing announced it.
  if (alwaysRedactTerms(sliceOptions.redaction).length === 0) {
    warnings.push(
      "No always-redact terms were supplied, so slices carry only the built-in path and secret " +
        "scrubbing. Pass `redaction` from config/redaction.yaml to apply the configured terms.",
    );
  }

  return { queued, skipped, warnings };
}

/**
 * Validates a subagent's extract, merges it over any previous one, advances the cursor, and writes
 * the file. Throws an Error listing every violation rather than persisting a half-trusted extract.
 */
export function commitExtract({
  paths,
  sessionKey,
  extract,
  session,
  now,
  redaction,
  homeDir,
} = {}) {
  const key = asText(sessionKey).trim() || asText(session?.key ?? session?.sessionKey).trim();
  if (key === "") throw new Error("commitExtract needs a sessionKey.");

  const payload = validateExtractPayload(extract);
  const resolved = resolvePaths(paths);
  const previous = loadExtract(resolved, key);

  // `publish` git-adds this file, so the title is published text and gets the same scrub a slice
  // gets. A thread title is model-generated from the work itself: it can carry a client's name or
  // the path someone was editing.
  const title = redactSlice(asText(session?.title).trim(), { homeDir, redaction }).trim();

  const document = {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    sessionKey: key,
    kind: asText(session?.kind).trim() || previous?.kind || null,
    projectKey: asText(session?.projectKey).trim() || previous?.projectKey || null,
    title: title || previous?.title || null,
    updatedAt: toIso(now) ?? new Date().toISOString(),
    cursor: advanceCursor(previous?.cursor ?? null, session),
    extract: payload,
    history: appendHistory(previous),
  };

  const file = extractPath(resolved, key);
  writeJsonFile(file, document);
  return { file, document };
}

/**
 * Recovers the JSON object from a subagent's reply: bare JSON, a fenced block, or an object buried
 * in prose. Throws when no object is recoverable — a silent `{}` would commit an empty extract.
 */
export function parseExtractPayload(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("The extract reply was empty; expected a JSON object.");
  }
  for (const candidate of jsonCandidates(text)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (isPlainObject(parsed)) return parsed;
  }
  throw new Error(
    `Could not find a JSON object in the extract reply (${text.length} characters read).`,
  );
}

// --- extract files ------------------------------------------------------------------------------

function normaliseDocument(doc, sessionKey) {
  if (!isPlainObject(doc)) return null;
  const version = Number(doc.schemaVersion ?? EXTRACT_SCHEMA_VERSION);
  // A file from a newer build is unreadable here; treating it as absent re-extracts once and
  // rewrites it in a shape this build understands.
  if (!Number.isFinite(version) || version > EXTRACT_SCHEMA_VERSION) return null;
  if (!isPlainObject(doc.extract)) return null;

  const extract = {
    problem: asText(doc.extract.problem),
    approach: asText(doc.extract.approach),
    outcome: asText(doc.extract.outcome),
    artifacts: arrayOf(doc.extract.artifacts).filter((entry) => typeof entry === "string"),
    status: asText(doc.extract.status),
  };
  // An extract that says nothing is indistinguishable from no extract, and pretending otherwise
  // would park the cursor past messages nobody ever summarised.
  if (extract.problem === "" && extract.approach === "" && extract.outcome === "") return null;

  const cursor = isPlainObject(doc.cursor) ? doc.cursor : {};
  return {
    schemaVersion: EXTRACT_SCHEMA_VERSION,
    sessionKey: asText(doc.sessionKey).trim() || asText(sessionKey).trim(),
    kind: asText(doc.kind).trim() || null,
    projectKey: asText(doc.projectKey).trim() || null,
    title: asText(doc.title).trim() || null,
    updatedAt: asText(doc.updatedAt).trim() || null,
    cursor: {
      lastEventAt: asText(cursor.lastEventAt).trim() || null,
      lastTurnId: asText(cursor.lastTurnId).trim() || null,
      turnsProcessed: nonNegativeInt(cursor.turnsProcessed) ?? 0,
    },
    extract,
    history: arrayOf(doc.history)
      .filter(isPlainObject)
      .map((entry) => ({ at: asText(entry.at).trim() || null, outcome: asText(entry.outcome) }))
      .slice(-MAX_HISTORY),
  };
}

function advanceCursor(previous, session) {
  const previousMs = parseIso(previous?.lastEventAt ?? null);
  const lastEventMs = lastEventMsOf(session);
  // Never rewind: a re-run over an older range must not re-open messages already summarised.
  const advanced = lastEventMs !== null && (previousMs === null || lastEventMs > previousMs);
  if (!advanced) {
    return {
      lastEventAt: previous?.lastEventAt ?? (lastEventMs === null ? null : toIso(lastEventMs)),
      lastTurnId: previous?.lastTurnId ?? null,
      turnsProcessed: nonNegativeInt(previous?.turnsProcessed) ?? 0,
    };
  }
  const newTurns = nonNegativeInt(session?.newTurnCount) ?? nonNegativeInt(session?.turnCount) ?? 0;
  return {
    lastEventAt: toIso(lastEventMs),
    lastTurnId: lastTurnIdOf(session) ?? previous?.lastTurnId ?? null,
    turnsProcessed: (nonNegativeInt(previous?.turnsProcessed) ?? 0) + newTurns,
  };
}

function appendHistory(previous) {
  const history = arrayOf(previous?.history).filter(isPlainObject);
  if (previous !== null && previous !== undefined) {
    history.push({ at: previous.updatedAt ?? null, outcome: asText(previous.extract?.outcome) });
  }
  return history.slice(-MAX_HISTORY);
}

function validateExtractPayload(value) {
  if (!isPlainObject(value)) {
    throw new Error(
      "Invalid extract: expected an object with problem, approach, outcome, artifacts and status.",
    );
  }

  const violations = [];
  const clean = { problem: "", approach: "", outcome: "", artifacts: [], status: "" };

  for (const field of EXTRACT_FIELDS) {
    const raw = value[field];
    if (typeof raw !== "string") {
      violations.push(`"${field}" must be text`);
      continue;
    }
    const text = raw.trim();
    if (text === "") violations.push(`"${field}" must not be empty`);
    else if (text.length > FIELD_MAX_CHARS) {
      violations.push(`"${field}" is ${text.length} characters; the limit is ${FIELD_MAX_CHARS}`);
    } else clean[field] = text;
  }

  // An omitted `artifacts` means "none"; anything present must be a clean list of strings.
  const artifacts = value.artifacts ?? [];
  if (!Array.isArray(artifacts)) violations.push(`"artifacts" must be an array of text entries`);
  else if (artifacts.length > MAX_ARTIFACTS) {
    violations.push(`"artifacts" has ${artifacts.length} entries; the limit is ${MAX_ARTIFACTS}`);
  } else {
    const bad = artifacts.findIndex((entry) => typeof entry !== "string" || entry.trim() === "");
    if (bad !== -1) violations.push(`"artifacts[${bad}]" must be non-empty text`);
    else clean.artifacts = artifacts.map((entry) => entry.trim());
  }

  const status = typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  if (!STATUSES.includes(status)) {
    violations.push(`"status" must be one of ${STATUSES.join(", ")}`);
  } else clean.status = status;

  if (violations.length > 0) throw new Error(`Invalid extract: ${violations.join("; ")}.`);
  return clean;
}

function writeJsonFile(file, document) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  try {
    NodeFS.writeFileSync(staging, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    NodeFS.renameSync(staging, file);
  } catch (error) {
    NodeFS.rmSync(staging, { force: true });
    throw error;
  }
}

// --- materiality --------------------------------------------------------------------------------

// Reads the counts the collector attached, falling back to the raw shapes both stores already
// produce (`promptCount`/`toolUseCount` on a Claude Code session, `files` and `turnCount` on a
// bundle session), so this works on a bundle session and on a freshly scanned one alike.
function materialityOf(session) {
  const source = isPlainObject(session?.materiality) ? session.materiality : (session ?? {});
  const files = arrayOf(session?.files);
  const turnsWithFiles =
    nonNegativeInt(source.turnsWithFiles) ??
    nonNegativeInt(source.completedTurnsWithFiles) ??
    (files.length > 0 ? 1 : 0);
  const toolActivities =
    nonNegativeInt(source.toolActivities) ??
    nonNegativeInt(source.activityCount) ??
    nonNegativeInt(source.toolUseCount) ??
    0;
  // `turnCount` is the collector's own stand-in for "how many times did the human ask for
  // something" — turns for a T3code thread, prompts for a Claude Code session.
  const userPrompts =
    nonNegativeInt(source.userPrompts) ??
    nonNegativeInt(source.promptCount) ??
    nonNegativeInt(session?.turnCount) ??
    0;
  // A collector that has already counted tool events keeps its verdict, but only in the positive
  // direction: it may add a session this bar would miss, never veto one this bar accepts.
  const flagged = session?.material === true || session?.needsExtraction === true;

  return {
    material:
      flagged ||
      turnsWithFiles >= 1 ||
      toolActivities >= MATERIAL_TOOL_ACTIVITIES ||
      userPrompts >= MATERIAL_USER_PROMPTS,
    turnsWithFiles,
    toolActivities,
    userPrompts,
    summary:
      `${turnsWithFiles} ${turnsWithFiles === 1 ? "turn" : "turns"} with files, ` +
      `${toolActivities} tool ${toolActivities === 1 ? "activity" : "activities"}, ` +
      `${userPrompts} ${userPrompts === 1 ? "prompt" : "prompts"}`,
  };
}

function lastEventMsOf(session) {
  const times = arrayOf(session?.eventTimes);
  const candidates = [
    session?.lastEventAt,
    session?.endedAt,
    session?.updatedAt,
    times.length > 0 ? times[times.length - 1] : null,
  ];
  let latest = null;
  for (const candidate of candidates) {
    const ms = parseIso(candidate ?? null);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

function lastTurnIdOf(session) {
  const explicit = asText(session?.lastTurnId).trim();
  if (explicit !== "") return explicit;
  const turns = arrayOf(session?.turns).filter(isPlainObject);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const id = asText(turns[index].turnId ?? turns[index].turn_id).trim();
    if (id !== "") return id;
  }
  return null;
}

function countNewEvents(session, cursorMs) {
  const times = arrayOf(session?.eventTimes);
  if (times.length > 0) {
    return times.filter((time) => {
      const ms = parseIso(time);
      return ms !== null && (cursorMs === null || ms > cursorMs);
    }).length;
  }
  const explicit = nonNegativeInt(session?.newEvents ?? session?.newEventCount);
  if (explicit !== null) return explicit;
  // Without a timeline the only honest answer is "at least one"; on a first extraction the turn
  // count is the closest thing to a size.
  if (cursorMs === null) return nonNegativeInt(session?.turnCount) ?? 1;
  return 1;
}

function byMaterialValue(left, right) {
  const leftValue = materialityOf(left.session);
  const rightValue = materialityOf(right.session);
  const leftTouched = leftValue.turnsWithFiles > 0 ? 1 : 0;
  const rightTouched = rightValue.turnsWithFiles > 0 ? 1 : 0;
  if (leftTouched !== rightTouched) return rightTouched - leftTouched;

  const leftTurns = nonNegativeInt(left.session?.turnCount) ?? 0;
  const rightTurns = nonNegativeInt(right.session?.turnCount) ?? 0;
  if (leftTurns !== rightTurns) return rightTurns - leftTurns;

  const byEvents = (right.decision.newEvents ?? 0) - (left.decision.newEvents ?? 0);
  if (byEvents !== 0) return byEvents;
  return left.sessionKey.localeCompare(right.sessionKey);
}

function identityOf(session, sessionKey) {
  return {
    sessionKey,
    title: asText(session?.title).trim() || null,
    projectKey: asText(session?.projectKey).trim() || null,
  };
}

/**
 * The default source of new material for a slice. Without this, `queue()` is a fully general
 * machine with nothing plugged into it: every slice came out holding file names and nothing else,
 * because only an injected `deps.loadInput` ever supplied prompts or activity.
 *
 * Opens the T3 databases once per `queue()` call and only when a T3code session actually needs
 * them. Claude Code sessions are served from the bundle, which already carries their first and last
 * prompt — re-reading a transcript to recover text the collector has in hand would be a second full
 * scan for nothing.
 */
function createDefaultLoadInput(bundle, warnings) {
  let handles = null;
  let opened = false;

  // The collected window, and the reason a first extraction is not garbage: with only a cursor as
  // a bound (null on a first run) the read starts at the beginning of the thread's history, so a
  // thread opened days ago fills today's slice with the wrong day's work — which is then
  // summarised and cached under today's date, where nothing ever revisits it.
  const bounds = bundleWindow(bundle);

  const ensureHandles = () => {
    if (opened) return handles;
    opened = true;
    // The bundle names the databases its evidence came from, and that list is the authority. There
    // is deliberately no fallback to whatever is on the machine right now: re-reading a different
    // set would mismatch the evidence, and it would let a test with a synthetic bundle reach into
    // the user's real history.
    const baseDirs = arrayOf(bundle?.config?.t3BaseDirs).filter((dir) => asText(dir).trim() !== "");
    if (baseDirs.length === 0) {
      warnings.push(
        "The bundle records no T3code database, so slices carry no prompts or activity.",
      );
      handles = [];
      return handles;
    }
    try {
      const result = openT3Databases(baseDirs);
      for (const warning of arrayOf(result?.warnings)) warnings.push(asText(warning));
      handles = arrayOf(result?.handles);
    } catch (error) {
      warnings.push(`Could not open the T3code databases for extraction: ${errorMessage(error)}`);
      handles = [];
    }
    return handles;
  };

  // A project's whole day of commits is not one session's evidence. Handed the lot, the subagent
  // writes another session's shipping into this session's extract, and the extract is cached — so
  // the misattribution outlives the run that made it.
  const commitsFor = (session) => {
    const repos = arrayOf(bundle?.git?.repos);
    const startMs = parseIso(session?.startedAt ?? null);
    const endMs = parseIso(session?.endedAt ?? null);
    const commits = [];
    for (const repo of repos) {
      if (session.projectKey !== null && repo?.projectKey !== session.projectKey) continue;
      for (const commit of arrayOf(repo?.commits)) {
        if (inSessionWindow(commit, startMs, endMs)) commits.push(commit);
      }
    }
    return commits;
  };

  const load = (session, { afterIso }) => {
    const commits = commitsFor(session);
    const key = asText(session?.key);

    if (session?.kind !== "t3code" || !key.startsWith("t3-")) {
      // A Claude Code session's text is already in the bundle; shape it like message rows.
      const messages = [
        { role: "user", text: asText(session?.firstPrompt), createdAt: session?.startedAt ?? null },
        { role: "user", text: asText(session?.lastPrompt), createdAt: session?.endedAt ?? null },
      ].filter((message) => message.text.trim() !== "");
      if (messages.length === 0) {
        // The bundle is the only source of prose for a standalone Claude Code session, so with
        // neither prompt there is nothing for a subagent to read but counts. Better to say so than
        // to pay for a summary of a contentless slice.
        warnings.push(
          `No prompt text is recorded for ${key === "" ? "an unkeyed session" : key}, so its ` +
            "slice carries counts and signals only.",
        );
      }
      const activities = arrayOf(session?.signals).map((signal) => ({ detail: asText(signal) }));
      return { messages, activities, commits };
    }

    const threadId = key.slice(3);
    const live = ensureHandles();
    if (live.length === 0) return { commits };

    const afterMs = parseIso(afterIso ?? null);
    // Whichever bound is later wins: the cursor on a resumed read, the window on a first one.
    // `afterIso` is exclusive (`created_at > ?`) while the window start is inclusive, so the
    // window goes in one millisecond early or a message stamped exactly at midnight vanishes.
    const messagesAfter = latestMs(afterMs, bounds.startMs === null ? null : bounds.startMs - 1);

    let messages = [];
    let activities = [];
    try {
      const rows = readThreadMessages(live, threadId, {
        afterIso: toIso(messagesAfter),
        limit: MAX_PROMPTS * 4,
      });
      // The upper bound is applied here because `readThreadMessages` takes no end: without one, a
      // thread still running tomorrow would put tomorrow's prompts in today's slice.
      messages = arrayOf(rows).filter((message) => isBefore(message?.createdAt, bounds.endMs));
    } catch (error) {
      warnings.push(`Could not read messages for ${key}: ${errorMessage(error)}`);
    }
    try {
      activities = arrayOf(
        readActivities(live, [threadId], {
          start: toIso(latestMs(afterMs, bounds.startMs, parseIso(session?.startedAt ?? null))),
          end: toIso(earliestMs(parseIso(session?.endedAt ?? null), bounds.endMs)),
          kinds: [
            "tool.completed",
            "task.progress",
            "task.started",
            "runtime.error",
            "runtime.warning",
          ],
        }),
      );
    } catch (error) {
      warnings.push(`Could not read activity for ${key}: ${errorMessage(error)}`);
    }
    return { messages, activities, commits };
  };

  load.close = () => {
    if (handles !== null) closeDatabases(handles);
    handles = null;
  };
  return load;
}

const NO_WINDOW = { startMs: null, endMs: null };

/**
 * The local window the bundle was collected for, as epoch ms. `collect()` emits local day keys
 * (`range.from`/`range.to`), so the bounds are rebuilt through the same calendar helper the
 * collector used — a day key must never be parsed as an instant, since `2026-08-10` parses as UTC
 * midnight and every day boundary in this feature is local. Explicit `startIso`/`endIso` fields
 * win when a caller already has resolved bounds.
 */
function bundleWindow(bundle) {
  const range = isPlainObject(bundle?.range) ? bundle.range : {};
  const startIso = parseIso(range.startIso ?? null);
  const endIso = parseIso(range.endIso ?? null);
  if (startIso !== null && endIso !== null && endIso > startIso) {
    return { startMs: startIso, endMs: endIso };
  }

  const days = arrayOf(range.days)
    .map((day) => asText(day).trim())
    .filter((day) => day !== "");
  const from = asText(range.from).trim() || days[0] || "";
  const to = asText(range.to).trim() || days[days.length - 1] || from;
  if (from === "") return NO_WINDOW;
  try {
    const resolved = rangeWindow(from, to);
    return { startMs: resolved.start.getTime(), endMs: resolved.end.getTime() };
  } catch {
    // A malformed range is the collector's problem to report. Here it only means "no bound", which
    // is exactly the behaviour that existed before the window was consulted at all.
    return NO_WINDOW;
  }
}

function inSessionWindow(commit, startMs, endMs) {
  // Nothing to judge against: a session with no window keeps the project's commits rather than
  // losing evidence on a guess.
  if (startMs === null && endMs === null) return true;
  const at = parseIso(commit?.at ?? commit?.committedAt ?? commit?.date ?? null);
  if (at === null) return true;
  if (startMs !== null && at < startMs) return false;
  return endMs === null || at <= endMs + COMMIT_GRACE_MS;
}

function isBefore(iso, endMs) {
  if (endMs === null) return true;
  const ms = parseIso(iso ?? null);
  // An unstamped row is not evidence of the wrong day, so it stays.
  return ms === null || ms < endMs;
}

function latestMs(...values) {
  return values.reduce((best, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return best;
    return best === null || value > best ? value : best;
  }, null);
}

function earliestMs(...values) {
  return values.reduce((best, value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return best;
    return best === null || value < best ? value : best;
  }, null);
}

// Both spellings, matching `redactSlice`: camelCase is what `registry.loadRedaction` returns, and
// snake_case is what a hand-built options object off the raw YAML carries.
function alwaysRedactTerms(redaction) {
  if (!isPlainObject(redaction)) return [];
  return arrayOf(redaction.alwaysRedact ?? redaction.always_redact)
    .map((term) => asText(term).trim())
    .filter((term) => term !== "");
}

function loadInput(deps, candidate, warnings) {
  if (typeof deps.loadInput !== "function") return {};
  let input;
  try {
    input = deps.loadInput(candidate.session, {
      afterIso: candidate.extract?.cursor?.lastEventAt ?? null,
      extract: candidate.extract,
    });
  } catch (error) {
    warnings.push(
      `Could not read new material for ${candidate.sessionKey}: ${errorMessage(error)}`,
    );
    return {};
  }
  if (typeof input?.then === "function") {
    warnings.push(
      `deps.loadInput must be synchronous; ignored an async result for ${candidate.sessionKey}.`,
    );
    return {};
  }
  if (!isPlainObject(input)) return {};
  for (const warning of arrayOf(input.warnings)) {
    const text = asText(warning).trim();
    if (text !== "") warnings.push(text);
  }
  return {
    messages: input.messages,
    activities: input.activities,
    commits: input.commits,
    files: input.files,
  };
}

// --- slice rendering ----------------------------------------------------------------------------

function sessionLines(session, scrub) {
  const lines = [];
  const push = (label, value) => {
    const text = scrub(value).trim();
    if (text !== "") lines.push(`- ${label}: ${text}`);
  };
  push("key", session?.key ?? session?.sessionKey);
  push("title", session?.title);
  push("project", session?.projectKey);
  push("branch", session?.branch ?? session?.gitBranch);
  push("models", arrayOf(session?.models).map(asText).filter(Boolean).join(", "));
  const turns = nonNegativeInt(session?.turnCount);
  if (turns !== null) lines.push(`- turns: ${turns}`);
  const window = [toIso(session?.startedAt ?? null), toIso(session?.endedAt ?? null)].filter(
    Boolean,
  );
  if (window.length > 0) lines.push(`- window: ${window.join(" -> ")}`);
  return lines;
}

function promptLines(session, messages, scrub) {
  // Scrub before truncating, always: cutting a secret in half would leave a fragment no pattern
  // recognises, and the truncation limit is about size, not safety.
  const prompts = messages
    .filter((message) => roleOf(message) === "user")
    .map((message) => truncate(scrub(textOf(message)), PROMPT_MAX_CHARS))
    .filter((text) => text.trim() !== "");

  // A Claude Code session that was scanned rather than queried keeps its prompts on the session.
  if (prompts.length === 0) {
    for (const fallback of [session?.firstPrompt, session?.lastPrompt]) {
      const text = truncate(scrub(fallback), PROMPT_MAX_CHARS);
      if (text.trim() !== "" && !prompts.includes(text)) prompts.push(text);
    }
  }
  if (prompts.length === 0) return [];

  const kept = prompts.slice(0, MAX_PROMPTS);
  const lines = kept.map((text, index) => `${index + 1}. ${text}`);
  if (prompts.length > kept.length) {
    lines.push(`(${prompts.length - kept.length} later prompts omitted)`);
  }
  return lines;
}

function assistantLines(messages, scrub) {
  const replies = messages
    .filter((message) => roleOf(message) === "assistant")
    .map((message) => truncate(scrub(textOf(message)), ASSISTANT_MAX_CHARS))
    .filter((text) => text !== "");
  if (replies.length === 0) return [];

  const lines = [`First reply: ${replies[0]}`];
  if (replies.length > 1) lines.push(`Last reply: ${replies[replies.length - 1]}`);
  return lines;
}

// Only `detail`, `taskTitle` and `toolName` are ever read from an activity. `data.result` and
// `data.input` hold full tool output and must not reach a slice, a prompt, or a disk file.
function activityLines(activities, scrub) {
  const seen = new Set();
  const lines = [];
  let omitted = 0;
  for (const activity of activities) {
    if (!isPlainObject(activity)) continue;
    const raw = asText(activity.detail) || asText(activity.taskTitle) || asText(activity.toolName);
    if (raw.trim() === "") continue;
    const line = truncate(scrub(reduceRelativePaths(flatten(raw))), ACTIVITY_MAX_CHARS);
    if (line.trim() === "" || seen.has(line)) continue;
    seen.add(line);
    if (lines.length >= MAX_ACTIVITY_LINES) {
      omitted += 1;
      continue;
    }
    lines.push(`- ${line}`);
  }
  if (omitted > 0) lines.push(`(${omitted} more distinct activities omitted)`);
  return lines;
}

function fileLines(files, scrub) {
  const totals = new Map();
  for (const file of files) {
    if (!isPlainObject(file)) continue;
    const name = basenameOnly(asText(file.path ?? file.file));
    if (name === "") continue;
    const entry = totals.get(name) ?? { additions: 0, deletions: 0 };
    entry.additions += nonNegativeInt(file.additions) ?? 0;
    entry.deletions += nonNegativeInt(file.deletions) ?? 0;
    totals.set(name, entry);
  }
  if (totals.size === 0) return [];

  const ordered = [...totals.entries()].sort((left, right) => {
    const churn = right[1].additions + right[1].deletions - (left[1].additions + left[1].deletions);
    return churn !== 0 ? churn : left[0].localeCompare(right[0]);
  });
  const lines = ordered
    .slice(0, MAX_FILES)
    .map(([name, churn]) => `- ${scrub(name)} +${churn.additions}/-${churn.deletions}`);
  if (ordered.length > MAX_FILES) lines.push(`(${ordered.length - MAX_FILES} more files omitted)`);
  return lines;
}

function commitLines(commits, scrub) {
  const subjects = [];
  for (const commit of commits) {
    const subject = isPlainObject(commit) ? asText(commit.subject) : asText(commit);
    const line = truncate(scrub(flatten(subject)), ACTIVITY_MAX_CHARS);
    if (line.trim() === "" || subjects.includes(line)) continue;
    subjects.push(line);
  }
  if (subjects.length === 0) return [];
  const lines = subjects.slice(0, MAX_COMMITS).map((subject) => `- ${subject}`);
  if (subjects.length > MAX_COMMITS) {
    lines.push(`(${subjects.length - MAX_COMMITS} more commits omitted)`);
  }
  return lines;
}

function renderSections(sections, dropped, scrubOptions) {
  const parts = sections.map((section) => [`## ${section.name}`, ...section.lines].join("\n"));
  // The note goes near the top, not the bottom: a slice that still overflows after every droppable
  // section is gone gets truncated from the end, and a note the reader never sees is not a note.
  if (dropped.length > 0) {
    parts.splice(1, 0, `_Omitted to fit the size cap: ${dropped.join(", ")}._`);
  }
  // Belt and braces: every field was scrubbed on the way in, and `redactSlice` is idempotent, so
  // this pass costs nothing and closes the gap if a future section forgets to scrub.
  return redactSlice(parts.join("\n\n"), scrubOptions);
}

function hardTruncate(text, maxChars) {
  const marker = "\n[slice truncated to fit the size cap]";
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

function reduceRelativePaths(text) {
  return text.replace(DEEP_RELATIVE_PATH, (matched) => basenameOnly(matched) || matched);
}

// --- payload recovery ---------------------------------------------------------------------------

function* jsonCandidates(text) {
  const trimmed = text.trim();
  yield trimmed;

  // Fenced blocks come next: a reply that explains itself around a ```json block is the common
  // shape, and the fence marks exactly where the object starts and ends.
  const fences = new RegExp(FENCED_BLOCK.source, "gu");
  let fence;
  while ((fence = fences.exec(text)) !== null) {
    const body = asText(fence[1]).trim();
    if (body !== "") yield body;
    if (fence.index === fences.lastIndex) fences.lastIndex += 1;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) yield trimmed.slice(first, last + 1);

  // Finally, brace matching: this is what survives trailing prose that contains its own `}`.
  yield* balancedObjects(trimmed);
}

function* balancedObjects(text) {
  const MAX_STARTS = 20;
  let starts = 0;
  for (let index = 0; index < text.length && starts < MAX_STARTS; index += 1) {
    if (text[index] !== "{") continue;
    starts += 1;
    const end = matchingBrace(text, index);
    if (end !== -1) yield text.slice(index, end + 1);
  }
}

function matchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// --- small helpers ------------------------------------------------------------------------------

function resolvePaths(paths) {
  if (typeof paths === "string" && paths.trim() !== "") return worklogPaths(paths);
  if (
    isPlainObject(paths) &&
    typeof paths.extracts === "string" &&
    typeof paths.slices === "string"
  ) {
    return paths;
  }
  if (isPlainObject(paths) && typeof paths.root === "string") return worklogPaths(paths.root);
  return worklogPaths();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function roleOf(message) {
  return isPlainObject(message) ? asText(message.role).trim().toLowerCase() : "";
}

function textOf(message) {
  if (!isPlainObject(message)) return "";
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  return "";
}

function truncate(text, maxChars) {
  const trimmed = asText(text).trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function flatten(text) {
  return asText(text).replace(/\s+/gu, " ").trim();
}

function nonNegativeInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function positiveInt(value) {
  const number = nonNegativeInt(value);
  return number === null || number === 0 ? null : number;
}

function findLastIndex(list, predicate) {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (predicate(list[index])) return index;
  }
  return -1;
}

function errorMessage(error) {
  const message = asText(error?.message) || String(error ?? "unknown error");
  // An error message can carry the very path the slice exists to hide.
  return redactSlice(message);
}
