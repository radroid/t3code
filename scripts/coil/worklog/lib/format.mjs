// Dates, durations, and number formatting for the /worklog collector.
//
// Everything day-shaped here is LOCAL time and calendar arithmetic — `new Date(y, m - 1, d)`,
// never `start + 86_400_000`. A worklog day is the day the human lived, so on the two DST
// transitions a day is 23 or 25 hours long and must still be exactly one calendar day. The
// stores we read (T3code SQLite, Claude Code JSONL) both stamp in UTC ISO, so the conversion
// happens here, once.

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

// A runaway guard for `eachDay`, not a policy limit: ~274 years of days. A real range that hits
// this is a caller bug, and looping forever would hang the collector instead of reporting it.
const MAX_RANGE_DAYS = 100_000;

/** Parses `YYYY-MM-DD` into a Date at local midnight; throws TypeError unless it is a real date. */
export function parseLocalDate(day) {
  if (typeof day !== "string") {
    throw new TypeError(`Expected a YYYY-MM-DD date string, got ${describe(day)}.`);
  }
  const match = DAY_PATTERN.exec(day.trim());
  if (match === null) throw new TypeError(`Malformed date "${day}" — expected YYYY-MM-DD.`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const date = new Date(year, month - 1, dayOfMonth);
  // `new Date` rolls overflow forward (2026-02-31 becomes March 3) and maps years < 100 into the
  // 1900s, so the round-trip is the only honest calendar check.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== dayOfMonth
  ) {
    throw new TypeError(`"${day}" is not a real calendar date.`);
  }
  return date;
}

/** Formats a Date (or ms / ISO string) as `YYYY-MM-DD` in local time; throws on invalid input. */
export function formatLocalDate(date) {
  const parsed = toDate(date);
  if (parsed === null) throw new TypeError(`Cannot format ${describe(date)} as a local date.`);
  const year = String(parsed.getFullYear()).padStart(4, "0");
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local `YYYY-MM-DD` for a Date / epoch-ms / ISO string; null when the input is unusable. */
export function localDayKey(dateOrIso) {
  const parsed = toDate(dateOrIso);
  return parsed === null ? null : formatLocalDate(parsed);
}

/** Half-open local window for one day: `[local midnight, next calendar date's local midnight)`. */
export function dayWindow(day) {
  const start = parseLocalDate(day);
  // Day + 1 via the calendar, so a 23h or 25h DST day still yields exactly one day. `new Date`
  // handles month and year overflow (Dec 31 + 1 → Jan 1).
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start, end };
}

/** Local window spanning `from`..`to` inclusive, plus the day keys; throws when `to` < `from`. */
export function rangeWindow(fromDay, toDay) {
  const days = eachDay(fromDay, toDay);
  return { start: dayWindow(fromDay).start, end: dayWindow(toDay).end, days };
}

/** Inclusive list of `YYYY-MM-DD` keys from `from` to `to`; throws when `to` < `from`. */
export function eachDay(fromDay, toDay) {
  const start = parseLocalDate(fromDay);
  const end = parseLocalDate(toDay);
  if (end.getTime() < start.getTime()) {
    throw new RangeError(`Range end "${toDay}" is before its start "${fromDay}".`);
  }

  const endKey = formatLocalDate(end);
  const days = [];
  for (let offset = 0; offset < MAX_RANGE_DAYS; offset += 1) {
    // Rebuilt from the anchor each step rather than mutated, so no DST hour can accumulate drift.
    const key = formatLocalDate(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset),
    );
    // A zone can skip a whole calendar date (Samoa had no 2011-12-30 when it crossed the date
    // line), which makes two consecutive offsets land on the same day. There is no worklog day
    // for a date nobody lived, so emit it once — never as a duplicate key a caller would
    // double-count.
    if (days.at(-1) !== key) days.push(key);
    if (key === endKey) return days;
  }
  throw new RangeError(`Range "${fromDay}".."${toDay}" spans more than ${MAX_RANGE_DAYS} days.`);
}

/** Human duration: `4h 12m`, `48m`, `35s`, `0m`. Always rounds down; hours are never wrapped to days. */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0m";

  const seconds = Math.floor(value / MS_PER_SECOND);
  // Sub-second spans read as "0m" rather than "0s": at that scale the honest answer is "nothing".
  if (seconds < 1) return "0m";
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(value / MS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(value / MS_PER_HOUR);
  const remainder = Math.floor((value - hours * MS_PER_HOUR) / MS_PER_MINUTE);
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/** Duration as decimal hours to one place: `4.2h`. Agent runtime is quoted this way. */
export function formatHours(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0.0h";
  return `${(value / MS_PER_HOUR).toFixed(1)}h`;
}

/** Thousands-separated number, pinned to en-US so output does not vary with the machine locale. */
export function formatNumber(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

/** The word only: `pluralize(1, "commit")` → "commit", `pluralize(2, "commit")` → "commits". */
export function pluralize(n, singular, plural) {
  const word = plural ?? `${singular}s`;
  return Math.abs(Number(n)) === 1 ? singular : word;
}

/** IANA timezone name for the report header, falling back to "local" when Intl is unavailable. */
export function timezoneName() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : "local";
  } catch {
    return "local";
  }
}

/** ISO-8601 string for a Date / epoch-ms / date string; null for null, undefined, or garbage. */
export function toIso(dateOrMs) {
  const parsed = toDate(dateOrMs);
  return parsed === null ? null : parsed.toISOString();
}

/** Epoch milliseconds for a timestamp of any accepted shape; null when it cannot be parsed. */
export function parseIso(s) {
  const parsed = toDate(s);
  return parsed === null ? null : parsed.getTime();
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return fromMs(value);
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (text === "") return null;
  // A bare run of 12+ digits is an epoch-millisecond stamp; `Date.parse` rejects it outright.
  // Shorter digit runs stay with `Date.parse`, so "1999" keeps meaning the year.
  if (/^-?\d{12,}$/u.test(text)) return fromMs(Number(text));
  return fromMs(Date.parse(text));
}

function fromMs(ms) {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  // Beyond ±8.64e15 ms the Date is Invalid even though the number was finite.
  return Number.isNaN(date.getTime()) ? null : date;
}

function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${value}"`;
  return typeof value;
}
