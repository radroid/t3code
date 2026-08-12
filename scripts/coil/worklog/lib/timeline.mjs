// Interval and activity-block math behind the two headline numbers in the worklog design (§5):
//
//   active time   — the union of activity blocks across every session. Parallel sessions must NOT
//                   double-count, so this is bounded by wall clock. "How long was I at the desk."
//   agent runtime — Σ per-span durations, overlaps counted twice. Sessions genuinely run in
//                   parallel, so this legitimately exceeds a day. "How much machine time I directed."
//
// An inflated stat is worse than no stat, so every function here is deliberately conservative:
// unparseable input is ignored rather than guessed at, reversed intervals contribute nothing, and
// `activeTimeline` is hard-bounded by its window.
//
// Pure functions, no I/O, no dependencies. Day boundaries are always LOCAL — `new Date(y, m-1, d)`
// — because a "day" in a work log is the day the human lived, not a UTC slice.

const MINUTE_MS = 60_000;
const DEFAULT_GAP_MS = 30 * MINUTE_MS;
const DEFAULT_SINGLE_EVENT_MS = MINUTE_MS;

// Ceiling on the day keys `splitByDay` will invent when the caller does not supply a day list. One
// corrupt timestamp can otherwise describe a range of centuries.
const MAX_DERIVED_DAYS = 4000;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

// A bare digit string is an epoch stamp, not a date: `Date.parse("1754870400000")` is NaN, while
// `Date.parse("2026")` is a legal ISO year. 12+ digits is past any year anyone would write down.
const EPOCH_STRING_PATTERN = /^-?\d{12,16}$/u;

/** Milliseconds for a `Date`, an ISO string, or an epoch-ms number; null when unparseable. */
export function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    if (EPOCH_STRING_PATTERN.test(text)) {
      const epoch = Number(text);
      return Number.isFinite(epoch) ? epoch : null;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Intersect an interval with a window, in ms; null when the overlap is empty or zero-length. */
export function clipInterval(interval, window) {
  const bounds = intervalBounds(interval);
  if (bounds === null) return null;
  const limits = windowBounds(window);
  const start = Math.max(bounds.start, limits.start);
  const end = Math.min(bounds.end, limits.end);
  // Zero-length counts as empty: an interval that only touches the window edge spans no time in it.
  if (!(end > start)) return null;
  return { start, end };
}

/** Union of intervals: sorted by start, with overlapping and exactly-adjacent ones merged. */
export function mergeIntervals(intervals) {
  const sorted = normalizeIntervals(intervals).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    // `<=` rather than `<` so [09:00,10:00] and [10:00,11:00] become one block — they describe
    // continuous activity, and leaving them apart would misreport a break that never happened.
    if (last !== undefined && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
      continue;
    }
    merged.push({ start: interval.start, end: interval.end });
  }
  return merged.map((interval) => withMs(interval.start, interval.end));
}

/** Total ms across intervals, overlaps counted twice — the agent-runtime sum, not the union. */
export function sumIntervals(intervals) {
  let total = 0;
  for (const interval of normalizeIntervals(intervals)) total += interval.end - interval.start;
  return total;
}

/**
 * Group timestamps into activity blocks, splitting wherever the gap between consecutive events is
 * GREATER than `gapMs` (a gap of exactly `gapMs` stays in one block).
 */
export function buildBlocks(timestamps, options = {}) {
  const gapMs = finiteOr(options.gapMs, DEFAULT_GAP_MS);
  const singleEventMs = finiteOr(options.singleEventMs, DEFAULT_SINGLE_EVENT_MS);

  const stamps = [];
  for (const value of asIterable(timestamps)) {
    const ms = toMs(value);
    if (ms !== null) stamps.push(ms);
  }
  if (stamps.length === 0) return [];
  stamps.sort((a, b) => a - b);

  const blocks = [];
  let blockStart = stamps[0];
  let previous = stamps[0];
  for (let index = 1; index < stamps.length; index += 1) {
    const stamp = stamps[index];
    if (stamp - previous > gapMs) {
      blocks.push(makeBlock(blockStart, previous, singleEventMs));
      blockStart = stamp;
    }
    previous = stamp;
  }
  blocks.push(makeBlock(blockStart, previous, singleEventMs));
  return blocks;
}

/** Sum the `ms` field of already-built blocks. */
export function activeMs(blocks) {
  let total = 0;
  for (const block of asIterable(blocks)) {
    const ms = Number(block?.ms);
    if (Number.isFinite(ms) && ms > 0) total += ms;
  }
  return total;
}

/**
 * Build activity blocks from a merged timestamp stream and clip them to a window, returning the
 * blocks with ISO bounds plus the window-bounded active total.
 */
export function activeTimeline(timestamps, options = {}) {
  const singleEventMs = finiteOr(options.singleEventMs, DEFAULT_SINGLE_EVENT_MS);
  const limits = windowBounds(options.window);

  const clipped = [];
  for (const block of buildBlocks(timestamps, options)) {
    if (block.end > block.start) {
      const piece = clipInterval(block, options.window);
      if (piece !== null) clipped.push(withMs(piece.start, piece.end));
      continue;
    }
    // A point block has no width to clip, so it is kept whole or dropped. The window is half-open,
    // matching splitByDay: an event landing exactly on midnight belongs to the following day.
    if (block.start >= limits.start && block.start < limits.end) {
      clipped.push({ start: block.start, end: block.end, ms: singleEventMs });
    }
  }

  // Active time claims to be bounded by wall clock, so enforce that rather than trusting it. Only
  // reachable when `singleEventMs` is configured larger than `gapMs` or than the window itself; in
  // that case `activeMs` is deliberately smaller than the sum of the returned blocks.
  const windowMs = limits.end - limits.start;
  const total = activeMs(clipped);
  return {
    blocks: clipped.map((block) => ({
      start: toIso(block.start),
      end: toIso(block.end),
      ms: block.ms,
    })),
    activeMs: Number.isFinite(windowMs) ? Math.min(total, Math.max(windowMs, 0)) : total,
  };
}

/**
 * Σ of span durations clipped to a window; a span with no end is still running and is closed at
 * `min(window.end, options.now ?? Date.now())`. Overlaps count twice and negatives are dropped.
 */
export function agentRuntimeMs(spans, window, options = {}) {
  const limits = windowBounds(window);
  const now = toMs(options.now) ?? Date.now();
  const openEnd = Math.min(limits.end, now);

  let total = 0;
  for (const span of asIterable(spans)) {
    const start = toMs(span?.start ?? span?.startedAt);
    if (start === null) continue;
    const rawEnd = span?.end ?? span?.endedAt ?? span?.completedAt;
    const end = rawEnd === null || rawEnd === undefined ? openEnd : toMs(rawEnd);
    if (end === null || !Number.isFinite(end)) continue;
    const piece = clipInterval({ start, end }, window);
    if (piece !== null) total += piece.end - piece.start;
  }
  return total;
}

/**
 * Split intervals across LOCAL day boundaries, keyed `YYYY-MM-DD`; an interval crossing midnight
 * appears in both days and the pieces sum to the original duration.
 */
export function splitByDay(intervals, days) {
  const normalized = [];
  for (const interval of asIterable(intervals)) {
    const bounds = intervalBounds(interval);
    if (bounds !== null) normalized.push({ source: interval, ...bounds });
  }

  // An explicit day list also defines the output keys, so a day with no work still gets an entry
  // and the caller can build `byDay` without re-checking for holes. With no usable list, fall back
  // to the days the intervals actually cover rather than returning nothing.
  const requested = normalizeDayKeys(days);
  const keys = requested.length > 0 ? requested : deriveDayKeys(normalized);

  const byDay = new Map();
  for (const key of keys) {
    const window = dayWindow(key);
    if (window === null) continue;
    const pieces = [];
    for (const item of normalized) {
      const piece = clipInterval(item, window);
      if (piece !== null) {
        pieces.push(carry(item.source, piece.start, piece.end, piece.end - piece.start));
        continue;
      }
      // A zero-width interval never survives clipping, but dropping it would silently lose a
      // single-event block. Place it in the day that contains it and keep its declared duration.
      if (item.end === item.start && item.start >= window.start && item.start < window.end) {
        pieces.push(carry(item.source, item.start, item.end, declaredMs(item.source)));
      }
    }
    byDay.set(key, pieces);
  }
  return byDay;
}

// --- internals -------------------------------------------------------------------------------

function makeBlock(start, end, singleEventMs) {
  // A block whose events all share one instant has no measurable duration but is still real
  // activity, so it is treated exactly like a lone event.
  return { start, end, ms: end > start ? end - start : singleEventMs };
}

function withMs(start, end) {
  return { start, end, ms: end - start };
}

function carry(source, start, end, ms) {
  // Extra fields (session key, repo, …) ride along so a split interval stays attributable.
  const extra =
    source !== null && typeof source === "object" && !(source instanceof Date) ? source : {};
  return { ...extra, start, end, ms };
}

function declaredMs(source) {
  const ms = Number(source?.ms);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function intervalBounds(interval) {
  if (interval === null || typeof interval !== "object") return null;
  const start = toMs(interval.start ?? interval.startedAt);
  const end = toMs(interval.end ?? interval.endedAt ?? interval.completedAt);
  if (start === null || end === null) return null;
  if (end < start) return null;
  return { start, end };
}

function windowBounds(window) {
  if (window === null || typeof window !== "object") {
    return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
  }
  return {
    start: toMs(window.start ?? window.startedAt) ?? Number.NEGATIVE_INFINITY,
    end: toMs(window.end ?? window.endedAt) ?? Number.POSITIVE_INFINITY,
  };
}

function normalizeIntervals(intervals) {
  const normalized = [];
  for (const interval of asIterable(intervals)) {
    const bounds = intervalBounds(interval);
    if (bounds !== null) normalized.push(bounds);
  }
  return normalized;
}

function normalizeDayKeys(days) {
  const keys = [];
  const seen = new Set();
  for (const day of asIterable(days)) {
    const key = typeof day === "string" ? day.trim() : dayKeyOf(toMs(day));
    if (key === null || key === "" || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function deriveDayKeys(intervals) {
  const seen = new Set();
  for (const interval of intervals) {
    let cursor = dayStart(interval.start);
    if (cursor === null) continue;
    for (let guard = 0; guard < MAX_DERIVED_DAYS; guard += 1) {
      const key = dayKeyOf(cursor.getTime());
      if (key !== null) seen.add(key);
      const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      // `>=` because the window is half-open: an interval ending exactly at midnight spends no
      // time in the following day and must not conjure a key for it.
      if (next.getTime() >= interval.end) break;
      cursor = next;
    }
  }
  return [...seen].sort();
}

function dayStart(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKeyOf(ms) {
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayWindow(key) {
  const match = DAY_KEY_PATTERN.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day);
  // Rejects impossible calendar dates (2026-02-31 would otherwise roll forward into March).
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return null;
  }
  // Local next-midnight, so DST days are honestly 23 or 25 hours long.
  const end = new Date(year, month - 1, day + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function asIterable(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || typeof value === "string") return [];
  return typeof value[Symbol.iterator] === "function" ? value : [];
}
