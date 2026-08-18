/**
 * Reader for the on-disk provider event log.
 *
 * `EventNdjsonLogger` writes one line per event as
 *
 *   `[<observedAt ISO>] <LABEL>: <json>\n`            (EventNdjsonLogger.ts:563)
 *
 * with three stream labels (EventNdjsonLogger.ts:166-168):
 *
 *   | label   | stream          | body                                              |
 *   |---------|-----------------|---------------------------------------------------|
 *   | `NTIVE` | `native`        | envelope whose `event.payload` is the raw SDK msg  |
 *   | `CANON` | `canonical`     | a `ProviderRuntimeEvent`, as emitted by the adapter |
 *   | `ORCH`  | `orchestration` | orchestration-side events                          |
 *
 * Both halves of the adapter boundary are therefore on disk: `NTIVE` is what the adapter
 * *consumed*, `CANON` is what it *produced*. A replay can feed the native stream back
 * through the real adapter and diff the result against the recorded canonical stream —
 * which is what makes a capture an executable regression test rather than a log dump.
 *
 * One fidelity caveat, deliberate upstream: canonical lines for seven high-frequency
 * types are never persisted (`transientCanonicalEventTypes`, EventNdjsonLogger.ts:39-47) —
 * `content.delta`, `hook.progress`, `item.updated`, `task.progress`,
 * `thread.realtime.audio.delta`, `tool.progress`, `turn.proposed.delta`. None are read by
 * auto-resume, but a differential replay must exclude them rather than report them missing.
 *
 * Parsing is total: logs are rotated and can be truncated mid-line by a crash, so a bad
 * line is collected as `malformed` and never throws.
 *
 * @module coil/autoResume/replay/providerLog
 */

/** Canonical event types the logger deliberately drops; excluded from any diff. */
export const TRANSIENT_CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);

export type ProviderLogStream = "native" | "canonical" | "orchestration";

const STREAM_BY_LABEL: Readonly<Record<string, ProviderLogStream>> = {
  NTIVE: "native",
  CANON: "canonical",
  ORCH: "orchestration",
};

export interface ProviderLogEntry {
  /** 1-based line number in the source file, so a finding cites the same line the user sees. */
  readonly lineNumber: number;
  readonly observedAt: string;
  readonly stream: ProviderLogStream;
  readonly body: unknown;
}

export interface ProviderLogMalformedLine {
  readonly lineNumber: number;
  readonly reason: "no-prefix" | "unknown-label" | "bad-json";
}

export interface ProviderLogParseResult {
  readonly entries: ReadonlyArray<ProviderLogEntry>;
  readonly malformed: ReadonlyArray<ProviderLogMalformedLine>;
}

const LINE_PATTERN = /^\[([^\]]+)\]\s+([A-Z]+):\s+(.*)$/s;

/** Parse one log line. Returns the entry, or the reason it could not be read. */
export function parseProviderLogLine(
  line: string,
  lineNumber: number,
): ProviderLogEntry | ProviderLogMalformedLine {
  const match = LINE_PATTERN.exec(line);
  if (match === null) return { lineNumber, reason: "no-prefix" };

  const [, observedAt, label, json] = match;
  const stream = STREAM_BY_LABEL[label!];
  if (stream === undefined) return { lineNumber, reason: "unknown-label" };

  try {
    return { lineNumber, observedAt: observedAt!, stream, body: JSON.parse(json!) as unknown };
  } catch {
    return { lineNumber, reason: "bad-json" };
  }
}

function isMalformed(
  value: ProviderLogEntry | ProviderLogMalformedLine,
): value is ProviderLogMalformedLine {
  return "reason" in value;
}

/** Parse a whole log file. Blank lines are ignored; malformed lines are reported, not thrown. */
export function parseProviderLog(contents: string): ProviderLogParseResult {
  const entries: ProviderLogEntry[] = [];
  const malformed: ProviderLogMalformedLine[] = [];

  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    const parsed = parseProviderLogLine(line, i + 1);
    if (isMalformed(parsed)) malformed.push(parsed);
    else entries.push(parsed);
  }

  return { entries, malformed };
}

/**
 * The raw SDK message carried by a `NTIVE` entry.
 *
 * `logNativeSdkMessage` writes `{ observedAt, event: { ..., payload: <SDKMessage> } }`
 * (ClaudeAdapter.ts:1690-1713), so the message sits at `event.payload`.
 */
export function nativeSdkMessage(entry: ProviderLogEntry): unknown | null {
  if (entry.stream !== "native") return null;
  const body = entry.body;
  if (typeof body !== "object" || body === null) return null;
  const event = (body as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return null;
  const payload = (event as { payload?: unknown }).payload;
  return payload === undefined ? null : payload;
}

/** The `ProviderRuntimeEvent` carried by a `CANON` entry (written verbatim, no envelope). */
export function canonicalRuntimeEvent(entry: ProviderLogEntry): unknown | null {
  if (entry.stream !== "canonical") return null;
  return typeof entry.body === "object" && entry.body !== null ? entry.body : null;
}

/** `type` of any parsed body, when it has one. Works for both streams. */
export function bodyType(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}
