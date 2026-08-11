// The one and only reader of T3code's `state.sqlite` for `/worklog`.
//
// Three rules hold this module together:
//   1. Read-only, always. Every database is opened with `readOnly: true`; nothing here writes.
//   2. Never load a table. The projection tables are hundreds of megabytes, so every read is a
//      parameterised window query. Timestamps are stored as ISO-8601 strings with a trailing `Z`,
//      which sort lexicographically, so `BETWEEN`-style string comparison is both correct and
//      index-friendly.
//   3. Never throw. A missing database, a drifted schema, or a corrupt JSON payload degrades to a
//      warning and an empty result — a work log is not worth crashing over.
//
// Warnings are collected per call. `openT3Databases` returns them explicitly; every other reader
// attaches them as a non-enumerable `warnings` property on the array/Map it returns, so callers
// that want diagnostics can read `rows.warnings` while `JSON.stringify`, spreads, and iteration
// stay completely unaffected.

import { DatabaseSync } from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Longest activity `detail` we ever return; tool details can otherwise run for kilobytes. */
const DETAIL_MAX_CHARS = 240;

/** Prompt normalisation window — long enough to identify a prompt, short enough to stay stable. */
const NORMALIZED_PROMPT_MAX_CHARS = 400;

// Modern SQLite allows 32766 bound parameters, but chunking keeps the generated SQL small and works
// on every build node:sqlite might ship.
const ID_CHUNK_SIZE = 400;

// Sentinels for an unbounded window. Both compare correctly against ISO-8601 strings.
const MIN_BOUND = "";
const MAX_BOUND = "9999-12-31T23:59:59.999Z";

const PROJECTS_TABLE = "projection_projects";
const THREADS_TABLE = "projection_threads";
const TURNS_TABLE = "projection_turns";
const ACTIVITIES_TABLE = "projection_thread_activities";
const MESSAGES_TABLE = "projection_thread_messages";

// db instance -> table name -> column names. Schema lookups are cheap but not free, and every
// reader needs them.
const columnCache = new WeakMap();

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function describeError(error) {
  if (error instanceof Error && isNonEmptyString(error.message)) return error.message;
  return String(error);
}

function stringOrNull(value) {
  return isNonEmptyString(value) ? value : null;
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (isNonEmptyString(value)) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncate(value, max) {
  if (typeof value !== "string") return null;
  if (value.length <= max) return value;
  // The ellipsis replaces a character rather than being appended, so the result never exceeds `max`.
  return `${value.slice(0, max - 1)}…`;
}

function parseJsonObject(text) {
  if (!isNonEmptyString(text)) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseJsonArray(text) {
  if (!isNonEmptyString(text)) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function placeholders(count) {
  return new Array(count).fill("?").join(", ");
}

function windowBounds(options) {
  return {
    start: isNonEmptyString(options?.start) ? options.start : MIN_BOUND,
    end: isNonEmptyString(options?.end) ? options.end : MAX_BOUND,
  };
}

function validHandles(handles) {
  return (Array.isArray(handles) ? handles : []).filter(
    (handle) => handle && handle.db && typeof handle.db.prepare === "function",
  );
}

/**
 * Normalises an id whitelist: `null`/`undefined` means "no filter", anything else becomes a
 * deduped array of non-empty strings (an empty one legitimately means "match nothing").
 */
function idWhitelist(value) {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter(isNonEmptyString))];
}

function tableColumns(handle, table) {
  let perDatabase = columnCache.get(handle.db);
  if (!perDatabase) {
    perDatabase = new Map();
    columnCache.set(handle.db, perDatabase);
  }
  const cached = perDatabase.get(table);
  if (cached) return cached;

  const columns = new Set();
  try {
    // pragma_table_info() returns zero rows for a table that does not exist, so a database that
    // never ran the projections (a fresh `~/.t3/dev`) falls out as "no columns" instead of throwing.
    for (const row of handle.db.prepare("SELECT name FROM pragma_table_info(?)").all(table)) {
      if (isNonEmptyString(row.name)) columns.add(row.name);
    }
  } catch {
    columns.clear();
  }
  perDatabase.set(table, columns);
  return columns;
}

/**
 * Picks the columns to select. Returns `null` when a column the query cannot work without is
 * missing, which is how upstream schema drift degrades to a skipped database instead of a crash.
 */
function selectableColumns(handle, table, required, optional, warnings) {
  const available = tableColumns(handle, table);
  if (available.size === 0) {
    warnings.push(`${table} is missing from ${handle.dbPath}; skipping it.`);
    return null;
  }
  const missing = required.filter((column) => !available.has(column));
  if (missing.length > 0) {
    warnings.push(`${table} in ${handle.dbPath} is missing ${missing.join(", ")}; skipping it.`);
    return null;
  }
  return [...required, ...optional.filter((column) => available.has(column))];
}

function queryAll(handle, sql, params, warnings, label) {
  try {
    return handle.db.prepare(sql).all(...params);
  } catch (error) {
    warnings.push(`${label} failed for ${handle.dbPath}: ${describeError(error)}`);
    return [];
  }
}

/**
 * Runs `buildSql(idCount)` once per chunk of ids (or once with `null` when there is no id filter),
 * so a thread list of any size stays inside SQLite's bound-parameter limit.
 */
function queryChunked(handle, buildSql, ids, tailParams, warnings, label) {
  if (ids === null) return queryAll(handle, buildSql(null), tailParams, warnings, label);
  const rows = [];
  for (const group of chunk(ids, ID_CHUNK_SIZE)) {
    rows.push(
      ...queryAll(handle, buildSql(group.length), [...group, ...tailParams], warnings, label),
    );
  }
  return rows;
}

function withWarnings(result, warnings) {
  // Non-enumerable: the array still stringifies, spreads, and compares as a plain array.
  Object.defineProperty(result, "warnings", { value: warnings, enumerable: false });
  return result;
}

function byTimestamp(a, b, first, second) {
  const primary = String(a[first] ?? "").localeCompare(String(b[first] ?? ""));
  if (primary !== 0) return primary;
  return String(a[second] ?? "").localeCompare(String(b[second] ?? ""));
}

/**
 * Opens every base dir's `state.sqlite` read-only. A base dir without a database is skipped
 * silently; one that exists but will not open produces a warning.
 */
export function openT3Databases(baseDirs) {
  const handles = [];
  const warnings = [];
  const seen = new Set();

  for (const baseDir of Array.isArray(baseDirs) ? baseDirs : []) {
    if (!isNonEmptyString(baseDir)) continue;
    const dbPath = NodePath.join(baseDir, "state.sqlite");
    if (!NodeFS.existsSync(dbPath)) continue;

    // Two base dirs can resolve to one file (a symlinked dev home). Opening it twice would silently
    // double every row every reader returns.
    let identity = dbPath;
    try {
      identity = NodeFS.realpathSync(dbPath);
    } catch {
      identity = dbPath;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);

    try {
      handles.push({ baseDir, dbPath, db: new DatabaseSync(dbPath, { readOnly: true }) });
    } catch (error) {
      warnings.push(`Could not open ${dbPath} read-only: ${describeError(error)}`);
    }
  }

  return { handles, warnings };
}

/** Closes every handle, ignoring anything that goes wrong on the way out. */
export function closeDatabases(handles) {
  for (const handle of Array.isArray(handles) ? handles : []) {
    try {
      handle?.db?.close();
    } catch {
      // A database that will not close cleanly is not worth failing a report over.
    }
  }
}

/** Reads every project row from every open database. */
export function readProjects(handles) {
  const warnings = [];
  const projects = [];

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      PROJECTS_TABLE,
      ["project_id"],
      ["title", "workspace_root", "deleted_at"],
      warnings,
    );
    if (!columns) continue;

    const sql = `SELECT ${columns.join(", ")} FROM ${PROJECTS_TABLE} ORDER BY project_id`;
    for (const row of queryAll(handle, sql, [], warnings, "readProjects")) {
      projects.push({
        baseDir: handle.baseDir,
        projectId: row.project_id,
        title: stringOrNull(row.title),
        workspaceRoot: stringOrNull(row.workspace_root),
        deletedAt: stringOrNull(row.deleted_at),
      });
    }
  }

  return withWarnings(projects, warnings);
}

function parseModels(modelSelectionJson) {
  const selection = parseJsonObject(modelSelectionJson);
  return isNonEmptyString(selection?.model) ? [selection.model] : [];
}

/**
 * Reads threads whose activity window overlaps `[start, end)` — i.e. touched before the window
 * closed and still updated after it opened.
 */
export function readThreads(handles, options) {
  const { start, end } = windowBounds(options);
  const warnings = [];
  const threads = [];

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      THREADS_TABLE,
      ["thread_id", "created_at", "updated_at"],
      [
        "project_id",
        "title",
        "branch",
        "worktree_path",
        "deleted_at",
        "archived_at",
        "model_selection_json",
        "latest_user_message_at",
      ],
      warnings,
    );
    if (!columns) continue;

    const sql =
      `SELECT ${columns.join(", ")} FROM ${THREADS_TABLE} ` +
      "WHERE updated_at >= ? AND created_at < ? ORDER BY created_at";
    for (const row of queryAll(handle, sql, [start, end], warnings, "readThreads")) {
      threads.push({
        baseDir: handle.baseDir,
        threadId: row.thread_id,
        projectId: stringOrNull(row.project_id),
        title: stringOrNull(row.title),
        branch: stringOrNull(row.branch),
        worktreePath: stringOrNull(row.worktree_path),
        createdAt: stringOrNull(row.created_at),
        updatedAt: stringOrNull(row.updated_at),
        deletedAt: stringOrNull(row.deleted_at),
        archivedAt: stringOrNull(row.archived_at),
        models: parseModels(row.model_selection_json),
        latestUserMessageAt: stringOrNull(row.latest_user_message_at),
      });
    }
  }

  return withWarnings(threads, warnings);
}

/** `checkpoint_files_json` is frequently `'[]'` and occasionally malformed, so parse it defensively. */
function parseCheckpointFiles(checkpointFilesJson) {
  const files = [];
  for (const entry of parseJsonArray(checkpointFilesJson)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const filePath = typeof entry.path === "string" ? entry.path.trim() : "";
    if (filePath === "") continue;
    files.push({
      path: filePath,
      kind: stringOrNull(entry.kind),
      additions: toFiniteNumber(entry.additions) ?? 0,
      deletions: toFiniteNumber(entry.deletions) ?? 0,
    });
  }
  return files;
}

/**
 * Reads turns whose run span overlaps `[start, end)`. A running turn (`completed_at IS NULL`) is
 * treated as still running now, so it counts for any window that has already opened.
 */
export function readTurns(handles, threadIds, options) {
  const ids = idWhitelist(threadIds);
  if (ids !== null && ids.length === 0) return withWarnings([], []);

  const { start, end } = windowBounds(options);
  // `now` is injectable so a test can pin the open end of a running turn.
  const now = isNonEmptyString(options?.now) ? options.now : new Date().toISOString();
  const warnings = [];
  const turns = [];

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      TURNS_TABLE,
      ["thread_id", "requested_at", "completed_at"],
      ["turn_id", "state", "started_at", "checkpoint_files_json"],
      warnings,
    );
    if (!columns) continue;

    const buildSql = (idCount) =>
      `SELECT ${columns.join(", ")} FROM ${TURNS_TABLE} WHERE ` +
      (idCount === null ? "" : `thread_id IN (${placeholders(idCount)}) AND `) +
      "requested_at < ? AND COALESCE(completed_at, ?) >= ? ORDER BY requested_at";

    for (const row of queryChunked(
      handle,
      buildSql,
      ids,
      [end, now, start],
      warnings,
      "readTurns",
    )) {
      turns.push({
        baseDir: handle.baseDir,
        threadId: row.thread_id,
        turnId: stringOrNull(row.turn_id),
        state: stringOrNull(row.state),
        requestedAt: stringOrNull(row.requested_at),
        startedAt: stringOrNull(row.started_at),
        completedAt: stringOrNull(row.completed_at),
        files: parseCheckpointFiles(row.checkpoint_files_json),
      });
    }
  }

  return withWarnings(turns, warnings);
}

/**
 * Pulls the only fields we are allowed to keep out of an activity payload.
 *
 * `payload.data.result` and `payload.data.input` carry full tool output — file contents, command
 * stdout, and anything a secret happened to be printed into. They are deliberately never read here,
 * so they cannot reach a bundle, a prompt, or a log line.
 */
function activityFacts(payloadJson) {
  const payload = parseJsonObject(payloadJson);
  if (!payload)
    return { detail: null, toolName: null, taskId: null, taskTitle: null, tokens: null };

  const data = payload.data !== null && typeof payload.data === "object" ? payload.data : null;
  const usage = payload.usage !== null && typeof payload.usage === "object" ? payload.usage : null;
  // Newer T3code builds write `typedUsage.totalTokens` where older ones wrote `usage.total_tokens`;
  // without the fallback every recent task would report zero tokens.
  const typedUsage =
    payload.typedUsage !== null && typeof payload.typedUsage === "object"
      ? payload.typedUsage
      : null;

  return {
    detail: truncate(payload.detail, DETAIL_MAX_CHARS),
    toolName: stringOrNull(data?.toolName),
    taskId: stringOrNull(payload.taskId),
    taskTitle: stringOrNull(payload.title),
    tokens: toFiniteNumber(usage?.total_tokens) ?? toFiniteNumber(typedUsage?.totalTokens),
  };
}

/**
 * Reads activity events inside `[start, end)`, optionally narrowed to a whitelist of kinds. The
 * `summary` column is deliberately not read: it is a generic label ("File change"), not a summary.
 */
export function readActivities(handles, threadIds, options) {
  const ids = idWhitelist(threadIds);
  if (ids !== null && ids.length === 0) return withWarnings([], []);
  const kinds = idWhitelist(options?.kinds);
  if (kinds !== null && kinds.length === 0) return withWarnings([], []);

  const { start, end } = windowBounds(options);
  const warnings = [];
  const activities = [];

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      ACTIVITIES_TABLE,
      ["thread_id", "kind", "created_at", "payload_json"],
      ["turn_id", "sequence"],
      warnings,
    );
    if (!columns) continue;

    const buildSql = (idCount) =>
      `SELECT ${columns.join(", ")} FROM ${ACTIVITIES_TABLE} WHERE ` +
      (idCount === null ? "" : `thread_id IN (${placeholders(idCount)}) AND `) +
      "created_at >= ? AND created_at < ?" +
      (kinds === null ? "" : ` AND kind IN (${placeholders(kinds.length)})`) +
      " ORDER BY created_at";

    const tail = kinds === null ? [start, end] : [start, end, ...kinds];
    for (const row of queryChunked(handle, buildSql, ids, tail, warnings, "readActivities")) {
      const facts = activityFacts(row.payload_json);
      activities.push({
        baseDir: handle.baseDir,
        threadId: row.thread_id,
        turnId: stringOrNull(row.turn_id),
        kind: stringOrNull(row.kind),
        createdAt: stringOrNull(row.created_at),
        sequence: toFiniteNumber(row.sequence),
        detail: facts.detail,
        toolName: facts.toolName,
        taskId: facts.taskId,
        taskTitle: facts.taskTitle,
        tokens: facts.tokens,
      });
    }
  }

  // Chunked, per-database queries arrive pre-sorted only within themselves; the timeline callers
  // build wants one merged order.
  activities.sort((a, b) => {
    const primary = String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
    if (primary !== 0) return primary;
    return (a.sequence ?? 0) - (b.sequence ?? 0);
  });

  return withWarnings(activities, warnings);
}

/**
 * Totals task tokens correctly: `usage.total_tokens` is cumulative per `taskId`, so the answer is
 * the max per task summed, never the sum of the rows. Rows without a `taskId` are ignored because
 * there is no way to tell a fresh count from a restated one.
 */
export function tokensByTask(activities) {
  const maxByTask = new Map();

  for (const activity of Array.isArray(activities) ? activities : []) {
    const taskId = activity?.taskId;
    if (!isNonEmptyString(taskId)) continue;
    const tokens = toFiniteNumber(activity?.tokens);
    if (tokens === null || tokens < 0) continue;
    const previous = maxByTask.get(taskId);
    if (previous === undefined || tokens > previous) maxByTask.set(taskId, tokens);
  }

  let total = 0;
  for (const tokens of maxByTask.values()) total += tokens;
  return total;
}

/**
 * Reads one thread's raw chat, oldest first. `afterIso` is exclusive — it is the extraction cursor,
 * and re-reading a message we have already summarised is what this whole design exists to avoid.
 */
export function readThreadMessages(handles, threadId, options) {
  const warnings = [];
  if (!isNonEmptyString(threadId)) return withWarnings([], warnings);

  const roles = idWhitelist(options?.roles);
  if (roles !== null && roles.length === 0) return withWarnings([], warnings);
  const afterIso = isNonEmptyString(options?.afterIso) ? options.afterIso : null;
  const limitValue = toFiniteNumber(options?.limit);
  const limit = limitValue !== null && limitValue >= 1 ? Math.floor(limitValue) : null;

  const messages = [];
  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      MESSAGES_TABLE,
      ["thread_id", "role", "text", "created_at"],
      ["message_id", "turn_id"],
      warnings,
    );
    if (!columns) continue;

    const sql =
      `SELECT ${columns.join(", ")} FROM ${MESSAGES_TABLE} WHERE thread_id = ?` +
      (afterIso === null ? "" : " AND created_at > ?") +
      (roles === null ? "" : ` AND role IN (${placeholders(roles.length)})`) +
      " ORDER BY created_at, message_id" +
      (limit === null ? "" : " LIMIT ?");

    const params = [threadId];
    if (afterIso !== null) params.push(afterIso);
    if (roles !== null) params.push(...roles);
    if (limit !== null) params.push(limit);

    for (const row of queryAll(handle, sql, params, warnings, "readThreadMessages")) {
      messages.push({
        messageId: stringOrNull(row.message_id),
        threadId: row.thread_id,
        turnId: stringOrNull(row.turn_id),
        role: stringOrNull(row.role),
        text: typeof row.text === "string" ? row.text : "",
        createdAt: stringOrNull(row.created_at),
      });
    }
  }

  // Each database already returned its own earliest `limit` rows, so re-sorting the union and
  // clipping again yields the true earliest `limit`.
  messages.sort((a, b) => byTimestamp(a, b, "createdAt", "messageId"));
  return withWarnings(limit === null ? messages : messages.slice(0, limit), warnings);
}

/** Earliest user prompt per thread inside `[start, end)`, as `Map<threadId, {text, createdAt}>`. */
export function firstUserPromptsByThread(handles, options) {
  const { start, end } = windowBounds(options);
  const warnings = [];
  const firstByThread = new Map();

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      MESSAGES_TABLE,
      ["thread_id", "text", "created_at", "role"],
      [],
      warnings,
    );
    if (!columns) continue;

    // SQLite guarantees that with a single MIN() aggregate the bare columns come from the matching
    // row, which gets us the earliest prompt per thread without reading the day's whole chat.
    const sql =
      `SELECT thread_id, text, MIN(created_at) AS created_at FROM ${MESSAGES_TABLE} ` +
      "WHERE role = 'user' AND created_at >= ? AND created_at < ? GROUP BY thread_id";

    for (const row of queryAll(handle, sql, [start, end], warnings, "firstUserPromptsByThread")) {
      if (!isNonEmptyString(row.thread_id) || !isNonEmptyString(row.created_at)) continue;
      const existing = firstByThread.get(row.thread_id);
      if (existing && existing.createdAt <= row.created_at) continue;
      firstByThread.set(row.thread_id, {
        text: typeof row.text === "string" ? row.text : "",
        createdAt: row.created_at,
      });
    }
  }

  return withWarnings(firstByThread, warnings);
}

/** Trimmed, whitespace-collapsed, lowercased, first 400 characters. */
export function normalizePrompt(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/gu, " ").toLowerCase().slice(0, NORMALIZED_PROMPT_MAX_CHARS);
}

/** SHA-256 hex of the normalised prompt — the join key between a Claude Code session and a thread. */
export function promptHash(text) {
  return NodeCrypto.createHash("sha256").update(normalizePrompt(text), "utf8").digest("hex");
}

/**
 * Indexes every user message in `[start, end)` by prompt hash, earliest occurrence winning, so a
 * Claude Code session's first prompt can be matched back to the T3code thread that issued it.
 */
export function promptHashIndex(handles, options) {
  const { start, end } = windowBounds(options);
  const warnings = [];
  const index = new Map();

  for (const handle of validHandles(handles)) {
    const columns = selectableColumns(
      handle,
      MESSAGES_TABLE,
      ["thread_id", "text", "created_at", "role"],
      [],
      warnings,
    );
    if (!columns) continue;

    const sql =
      `SELECT thread_id, text, created_at FROM ${MESSAGES_TABLE} ` +
      "WHERE role = 'user' AND created_at >= ? AND created_at < ? ORDER BY created_at";

    for (const row of queryAll(handle, sql, [start, end], warnings, "promptHashIndex")) {
      if (!isNonEmptyString(row.thread_id) || !isNonEmptyString(row.created_at)) continue;
      // An empty prompt normalises to one shared hash, which would link unrelated sessions.
      if (normalizePrompt(row.text) === "") continue;
      const hash = promptHash(row.text);
      const existing = index.get(hash);
      if (existing && existing.createdAt <= row.created_at) continue;
      index.set(hash, { threadId: row.thread_id, createdAt: row.created_at });
    }
  }

  return withWarnings(index, warnings);
}
