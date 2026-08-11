// Reads Claude Code's transcripts: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
//
// Two constraints shape every function here.
//
// 1. Volume. There are hundreds of these files and a busy one is ~1 MB, so nothing is ever read
//    whole: files are prefiltered on mtime (a file with in-window activity must have been written
//    at or after the window opened) and then streamed a line at a time. A single day's window
//    typically survives the prefilter with a handful of files.
// 2. Read-only, never-throw. This walks the user's real home directory. Every public function
//    degrades a missing directory, an unreadable file, or a half-written line into a warning.
//
// The directory name is a lossy encoding of the cwd (both `/` and `.` become `-`), so paths are
// always read off the records themselves and never decoded from the directory name.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

/** How much prompt text is kept in the bundle. The narrative only ever needs the opening lines. */
const PROMPT_TEXT_LIMIT = 2000;

/** Prefix of the normalised prompt that gets hashed. Must stay in lockstep with lib/t3db.mjs. */
const PROMPT_HASH_PREFIX_LIMIT = 400;

const JSONL_SUFFIX = ".jsonl";

// Text Claude Code wraps around slash-command expansions and harness-injected context. These
// records are real user turns — the work that follows one is genuinely the agent responding — but
// the text is machinery, not something a human wrote about their day.
//
// The list is closed rather than a generic `^<tag>` match so that a real prompt about markup ("fix
// <header> on the landing page") is never mistaken for machinery. It covers every wrapper present
// in this user's 475 transcripts; `<task-notification>` is the most common of them by far and also
// the most dangerous to keep, because its body is a block of absolute temp paths.
const WRAPPER_PREFIXES = [
  "<system-reminder>",
  "<task-notification>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "Caveat:",
];

/** Normalise a prompt for hashing: trim, collapse whitespace, lowercase, keep the first 400 chars. */
export function normalizePrompt(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/gu, " ").toLowerCase().slice(0, PROMPT_HASH_PREFIX_LIMIT);
}

/** SHA-256 (hex) of the normalised prompt — the join key between a session and a T3code thread. */
export function promptHash(text) {
  return NodeCrypto.createHash("sha256").update(normalizePrompt(text), "utf8").digest("hex");
}

/** List the session transcripts one level under `projectsDir` modified at or after `since`. */
export function listSessionFiles(projectsDir, options = {}) {
  const since = toEpochMs(options?.since, Number.NEGATIVE_INFINITY);
  const found = [];
  if (typeof projectsDir !== "string" || projectsDir === "") return found;

  let projectDirs;
  try {
    projectDirs = NodeFS.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of projectDirs) {
    // Only one level deep. A session's own subdirectory holds subagent transcripts
    // (<sessionId>/subagents/...), which are not sessions and must not be listed as such.
    if (!isDirectory(projectsDir, entry)) continue;
    const dir = NodePath.join(projectsDir, entry.name);
    let files;
    try {
      files = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.name.endsWith(JSONL_SUFFIX)) continue;
      const full = NodePath.join(dir, file.name);
      let stats;
      try {
        stats = NodeFS.statSync(full);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.mtimeMs < since) continue;
      found.push({
        file: full,
        dir,
        sessionId: file.name.slice(0, -JSONL_SUFFIX.length),
        mtimeMs: stats.mtimeMs,
      });
    }
  }

  found.sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file));
  return found;
}

/** Read one session transcript, keeping only records inside the window; null when none are. */
export async function readSessionFile(file, options = {}) {
  const { session } = await readSessionDetailed(file, options);
  return session;
}

/** Scan every session file in `projectsDir` for window activity; failures become warnings. */
export async function scanSessions(projectsDir, options = {}) {
  const warnings = [];
  const sessions = [];

  if (typeof projectsDir !== "string" || projectsDir === "") {
    warnings.push("No Claude Code projects directory configured; skipped the session scan.");
    return { sessions, warnings };
  }
  if (!NodeFS.existsSync(projectsDir)) {
    warnings.push(`Claude Code projects directory not found: ${projectsDir}`);
    return { sessions, warnings };
  }

  const start = toEpochMs(options?.start, Number.NEGATIVE_INFINITY);
  const candidates = listSessionFiles(projectsDir, { since: start });

  const limit = Number.isSafeInteger(options?.limit) && options.limit >= 0 ? options.limit : null;
  let queue = candidates;
  if (limit !== null && candidates.length > limit) {
    // listSessionFiles sorts newest-modified first, so a truncated scan keeps the freshest work.
    queue = candidates.slice(0, limit);
    warnings.push(
      `Read only the ${limit} most recently modified of ${candidates.length} Claude Code session files.`,
    );
  }

  // Sequential on purpose: the mtime prefilter has already cut this to the files that can matter,
  // and serial reads keep both memory and the warning order deterministic.
  for (const candidate of queue) {
    const result = await readSessionDetailed(candidate.file, options);
    warnings.push(...result.warnings);
    if (result.session) sessions.push(result.session);
  }

  sessions.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.sessionId.localeCompare(right.sessionId),
  );
  return { sessions, warnings };
}

/** Mark each session `excluded` when the evidence says T3code drove it (§6 dedup ladder). */
export function linkSessions(sessions, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];

  const worktreeRoots = [];
  for (const root of toArray(options?.worktreeRoots)) {
    const normalized = normalizePath(root);
    if (normalized) worktreeRoots.push(normalized);
  }

  const threadRoots = [];
  for (const thread of toArray(options?.threads)) {
    const path = normalizePath(thread?.worktreePath ?? thread?.worktree_path);
    if (!path) continue;
    threadRoots.push({ path, threadId: thread?.threadId ?? thread?.thread_id ?? null });
  }

  const lookupHash = makeHashLookup(options?.promptHashes);

  for (const session of list) {
    if (!session || typeof session !== "object") continue;
    session.excluded = classifySession(session, worktreeRoots, threadRoots, lookupHash);
  }
  return list;
}

/**
 * Prompts that a machine sends on the user's behalf. Each one opens a real Claude Code session in a
 * real workspace, so nothing structural distinguishes it from work — but counting them is what took
 * a 13-thread day to "43 sessions" the first time this ran. Grounded in the code that sends them:
 *   - the two title prompts: apps/server/src/textGeneration/TextGenerationPrompts.ts
 *   - the security-review prompts: the security-guidance plugin's hooks/llm.py
 *   - "Say hi in one word.": a provider reachability probe
 * Matched against the session's first prompt, case-insensitively, as a prefix.
 */
export const MACHINE_PROMPT_PREFIXES = Object.freeze([
  "generate a title that will help the user recognize this t3 code thread",
  "regenerate the title for an existing t3 code thread",
  "review this change for security vulnerabilities",
  "you previously flagged these candidate vulnerabilities",
  "say hi in one word",
  // The textGeneration system prompts, verbatim from TextGenerationPrompts.ts.
  "you write concise git commit messages",
  "you generate concise git branch names",
  "you write source control change request content",
  // Older builds phrased title generation this way; historical days still contain it.
  "you write concise thread titles",
]);

/**
 * A system-prompt-shaped directive: short, one line, second person, imperative, full stop. Every
 * T3code text-generation call opens with one, and the literal list above cannot keep up on its own
 * — it already missed a phrasing from an older build that is still sitting in August's history.
 *
 * Deliberately narrow, because a human could plausibly type "You generate the report and I'll
 * review it.": the caller additionally requires a session of at most two prompts, and a person who
 * opens like that keeps talking.
 */
const MACHINE_DIRECTIVE =
  /^you (?:write|generate|are|produce|create|summarise|summarize|extract|classify)\b[^\n?]{0,110}\.$/iu;

/**
 * True when a session looks like tooling talking to itself rather than a person working. The prefix
 * list is the precise arm; the structural arm is deliberately narrow (one turn, nothing touched,
 * over in a couple of minutes) so a genuine quick question is never swallowed.
 */
export function isMachineSession(session) {
  const prompt = String(session?.firstPrompt ?? "")
    .trim()
    .toLowerCase();
  if (prompt !== "" && MACHINE_PROMPT_PREFIXES.some((prefix) => prompt.startsWith(prefix))) {
    return { machine: true, rule: "known-prompt" };
  }

  const promptCount = session?.promptCount ?? 0;
  if (prompt !== "" && promptCount <= 2 && MACHINE_DIRECTIVE.test(prompt.trim())) {
    return { machine: true, rule: "machine-directive" };
  }

  const started = Date.parse(session?.startedAt ?? "");
  const ended = Date.parse(session?.endedAt ?? "");
  const durationMs =
    Number.isFinite(started) && Number.isFinite(ended) ? ended - started : Infinity;
  const structural =
    (session?.promptCount ?? 0) <= 1 &&
    (session?.assistantCount ?? 0) <= 2 &&
    (session?.toolUseCount ?? 0) <= 1 &&
    durationMs < 120_000;
  return structural ? { machine: true, rule: "utility-shape" } : { machine: false, rule: null };
}

// --- internals ---------------------------------------------------------------------------------

function classifySession(session, worktreeRoots, threadRoots, lookupHash) {
  const machine = isMachineSession(session);
  if (machine.machine) {
    return { reason: "machine-generated", rule: machine.rule, linkedTo: null };
  }

  const cwd = normalizePath(session.cwd);
  if (cwd) {
    // A thread match is tried before the generic roots so `linkedTo` gets filled in when we can
    // actually name the thread; both are the same rung of the ladder.
    const thread = threadRoots.find((candidate) => isUnder(cwd, candidate.path));
    if (thread) {
      return { reason: "t3code-driven", rule: "worktree", linkedTo: thread.threadId ?? null };
    }
    if (worktreeRoots.some((root) => isUnder(cwd, root))) {
      return { reason: "t3code-driven", rule: "worktree", linkedTo: null };
    }
  }

  for (const hash of toArray(session.promptHashes)) {
    const hit = lookupHash(hash);
    if (!hit) continue;
    const threadId = typeof hit === "string" ? hit : (hit.threadId ?? hit.thread_id ?? null);
    return { reason: "t3code-driven", rule: "prompt-hash", linkedTo: threadId };
  }

  return null;
}

// Returns { session, warnings }. readSessionFile exposes only the session, but scanSessions needs
// to tell "nothing in this window" (silent, and the common case) apart from "this file is broken".
async function readSessionDetailed(file, options = {}) {
  const warnings = [];
  const sessionId = NodePath.basename(String(file ?? "")).replace(/\.jsonl$/iu, "");
  const start = toEpochMs(options?.start, Number.NEGATIVE_INFINITY);
  const end = toEpochMs(options?.end, Number.POSITIVE_INFINITY);

  const cwdCounts = new Map();
  const branchCounts = new Map();
  const versions = new Set();
  const models = new Set();
  const seenHashes = new Set();
  const promptHashes = [];
  const seenPrLinks = new Set();
  const prLinks = [];
  const eventTimes = [];
  const turnSpans = [];

  let promptCount = 0;
  let assistantCount = 0;
  let toolUseCount = 0;
  let firstPrompt = null;
  let lastPrompt = null;
  let trailingLastPrompt = null;
  let inWindowCount = 0;
  let nonSidechainCount = 0;
  let parsedLines = 0;
  let malformedLines = 0;
  let openSpanStart = null;
  let previousEventAt = null;

  const closeSpan = (endAt) => {
    if (openSpanStart === null) return;
    // A prompt with nothing after it collapses to a zero-length span rather than an inverted one.
    turnSpans.push({
      start: openSpanStart,
      end: endAt === null || endAt < openSpanStart ? openSpanStart : endAt,
    });
    openSpanStart = null;
  };

  const stream = NodeFS.createReadStream(file, { encoding: "utf8" });
  const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      if (!record || typeof record !== "object") {
        malformedLines += 1;
        continue;
      }
      parsedLines += 1;

      // `last-prompt` records carry no timestamp, so they can never be an event. Held aside as a
      // fallback for a window whose own records contain no narratable prompt.
      if (record.type === "last-prompt" && typeof record.lastPrompt === "string") {
        trailingLastPrompt = record.lastPrompt;
      }

      const timestamp =
        typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;

      const at = new Date(timestamp).toISOString();
      inWindowCount += 1;
      eventTimes.push(at);
      if (record.isSidechain !== true) nonSidechainCount += 1;
      increment(cwdCounts, record.cwd);
      increment(branchCounts, record.gitBranch);
      if (typeof record.version === "string" && record.version !== "") versions.add(record.version);

      if (record.type === "pr-link") {
        collectPrLink(record, at, prLinks, seenPrLinks);
      } else if (record.type === "assistant") {
        assistantCount += 1;
        const model = record.message?.model;
        if (typeof model === "string" && model !== "") models.add(model);
        const content = record.message?.content;
        if (Array.isArray(content) && content.some((block) => block?.type === "tool_use")) {
          toolUseCount += 1;
        }
      } else if (record.type === "user" && record.isSidechain !== true) {
        const text = userText(record);
        if (text !== null) {
          // Every user turn is a turn boundary, wrapper or not — `previousEventAt` is still the
          // record before this one because the assignment below has not run yet.
          closeSpan(previousEventAt);
          openSpanStart = at;

          if (text.trim() !== "" && !isWrapperText(text)) {
            promptCount += 1;
            const kept = truncate(text, PROMPT_TEXT_LIMIT);
            if (firstPrompt === null) firstPrompt = kept;
            lastPrompt = kept;
            const hash = promptHash(text);
            if (!seenHashes.has(hash)) {
              seenHashes.add(hash);
              promptHashes.push(hash);
            }
          }
        }
      }

      previousEventAt = at;
    }
  } catch (error) {
    warnings.push(`Could not read ${sessionId}${JSONL_SUFFIX}: ${errorMessage(error)}`);
    return { session: null, warnings };
  } finally {
    lines.close();
    stream.destroy();
  }

  if (parsedLines === 0) {
    if (malformedLines > 0) {
      warnings.push(
        `Skipped ${sessionId}${JSONL_SUFFIX}: all ${malformedLines} lines failed to parse.`,
      );
    }
    return { session: null, warnings };
  }
  if (inWindowCount === 0) return { session: null, warnings };
  if (malformedLines > 1) {
    // One bad line is the tail of a session still being written; several means real corruption.
    warnings.push(`Ignored ${malformedLines} unparsable lines in ${sessionId}${JSONL_SUFFIX}.`);
  }

  closeSpan(previousEventAt);
  // toISOString() is fixed-width UTC, so a lexicographic sort is a chronological one.
  eventTimes.sort();

  const session = {
    sessionId,
    file,
    cwd: mostFrequent(cwdCounts),
    gitBranch: mostFrequent(branchCounts),
    versions: [...versions],
    models: [...models],
    startedAt: eventTimes[0],
    endedAt: eventTimes[eventTimes.length - 1],
    promptCount,
    assistantCount,
    toolUseCount,
    firstPrompt,
    lastPrompt:
      lastPrompt ??
      (trailingLastPrompt === null ? null : truncate(trailingLastPrompt, PROMPT_TEXT_LIMIT)),
    promptHashes,
    prLinks,
    eventTimes,
    turnSpans,
    sidechainOnly: nonSidechainCount === 0,
    excluded: null,
  };
  return { session, warnings };
}

// The first text block, or null when this is not a user text turn at all. Deliberately only the
// first block: the hash has to match the plain message text T3code stored for the same prompt, so
// appended blocks (images, injected reminders) must not bleed into it.
function userText(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0]?.type === "text") {
    return typeof content[0].text === "string" ? content[0].text : "";
  }
  return null;
}

function isWrapperText(text) {
  const head = text.trimStart();
  return WRAPPER_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function collectPrLink(record, at, prLinks, seen) {
  const number = Number(record.prNumber);
  if (!Number.isSafeInteger(number)) return;
  const repository = typeof record.prRepository === "string" ? record.prRepository : null;
  const key = `${number}|${repository ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  prLinks.push({
    number,
    url: typeof record.prUrl === "string" ? record.prUrl : null,
    repository,
    at,
  });
}

function isDirectory(parent, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return NodeFS.statSync(NodePath.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function increment(counts, value) {
  if (typeof value !== "string" || value === "") return;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

// Sessions move between worktrees mid-run, so the majority value is the honest answer. Ties go to
// the first value seen, which Map insertion order gives us for free.
function mostFrequent(counts) {
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function truncate(text, limit) {
  if (typeof text !== "string") return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function makeHashLookup(source) {
  if (!source) return () => null;
  if (typeof source.get === "function") return (hash) => source.get(hash) ?? null;
  if (typeof source === "object") {
    return (hash) => (Object.prototype.hasOwnProperty.call(source, hash) ? source[hash] : null);
  }
  return () => null;
}

function normalizePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const normalized = NodePath.normalize(value.trim());
  return normalized.length > 1 ? normalized.replace(/[/\\]+$/u, "") : normalized;
}

function isUnder(child, parent) {
  return (
    child === parent ||
    child.startsWith(parent.endsWith(NodePath.sep) ? parent : parent + NodePath.sep)
  );
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toEpochMs(value, fallback) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : fallback;
  }
  return fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
