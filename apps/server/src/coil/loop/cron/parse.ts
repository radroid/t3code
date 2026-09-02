// @effect-diagnostics globalDate:off - calendar arithmetic on an explicit `nowMs`; this reads no ambient clock.
/**
 * Fork-owned 5-field cron parser.
 *
 * There is no cron parser anywhere in this repo and this must not add a dependency: a
 * general parser handles a grammar the producer never emits. The producer's grammar is
 * documented and narrow — *"Standard 5-field cron expression in local time: `M H DoM Mon
 * DoW`"*, with the terms `*`, `N` and `A-B`, either of the first and last optionally
 * followed by a `/S` step, plus comma-lists of those. **No seconds field, no `@daily`
 * macros, no `JAN`/`MON` names.** Anything outside that yields `null`, which
 * means **no deference from that entry** — an unparseable schedule must never stand
 * supervision down, and it must never mean "defer forever".
 *
 * The one-shot form (`recurring: false`) is the same grammar: the binary encodes the single
 * instant into the same five fields, all concrete, so "the next match strictly after now" is
 * exactly that instant. This is why one call covers both forms. It also means the value is
 * only correct if computed *when the entry is observed* — a one-shot re-parsed after it has
 * fired resolves to next year's occurrence, which is why `crons.ts` computes `nextFireAtMs`
 * at hook time and persists it rather than re-deriving it on each tick.
 *
 * Everything is evaluated in wall-clock time (the tool says "local time"), which is what
 * makes it DST-correct rather than DST-ignorant: candidates are generated as calendar
 * minutes and only then converted to an instant, so a `0 3 * * *` job is 03:00 local on both
 * sides of a transition. A wall-clock minute that does not exist (the spring-forward gap) is
 * skipped; one that occurs twice (the fall-back repeat) resolves to its first occurrence.
 *
 * @module coil/loop/cron/parse
 */

/** > 4 years, so a search that can only match on Feb 29 still terminates on a real date. */
const MAX_SEARCH_DAYS = 1500;

const INTEGER = /^\d+$/;

interface WallClock {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly hour: number; // 0-23
  readonly minute: number; // 0-59
}

interface ParsedCron {
  readonly minutes: ReadonlyArray<number>;
  readonly hours: ReadonlyArray<number>;
  readonly daysOfMonth: ReadonlyArray<number>;
  readonly months: ReadonlyArray<number>;
  readonly daysOfWeek: ReadonlyArray<number>;
  /**
   * Whether the day-of-month / day-of-week fields were written as anything other than `*`.
   *
   * Cron's one genuinely surprising rule: when *both* day fields are restricted a day
   * matches if *either* does (a union, not an intersection), so `0 9 1 * 1` is "the 1st and
   * every Monday", not "Mondays that fall on the 1st".
   */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

/**
 * Expands one comma-separated term of a field.
 *
 * A step with no range (`5/2`) is deliberately rejected: it is Vixie cron, not the
 * producer's documented grammar, and guessing at it would defer supervision on an
 * expression we cannot claim to understand.
 */
function parseTerm(term: string, min: number, max: number): ReadonlyArray<number> | null {
  const slash = term.indexOf("/");
  const rangeText = slash === -1 ? term : term.slice(0, slash);

  let step = 1;
  if (slash !== -1) {
    const stepText = term.slice(slash + 1);
    if (!INTEGER.test(stepText)) return null;
    step = Number(stepText);
    if (step < 1 || step > max - min + 1) return null;
  }

  let low: number;
  let high: number;
  if (rangeText === "*") {
    low = min;
    high = max;
  } else {
    const dash = rangeText.indexOf("-");
    if (dash === -1) {
      if (slash !== -1) return null;
      if (!INTEGER.test(rangeText)) return null;
      low = Number(rangeText);
      high = low;
    } else {
      const lowText = rangeText.slice(0, dash);
      const highText = rangeText.slice(dash + 1);
      if (!INTEGER.test(lowText) || !INTEGER.test(highText)) return null;
      low = Number(lowText);
      high = Number(highText);
      // Wrap-around ranges (`22-2`) are not in the producer's grammar.
      if (low > high) return null;
    }
  }

  if (low < min || high > max) return null;

  const values: Array<number> = [];
  for (let value = low; value <= high; value += step) values.push(value);
  return values;
}

function parseField(raw: string, min: number, max: number): ReadonlyArray<number> | null {
  const values = new Set<number>();
  for (const term of raw.split(",")) {
    const expanded = parseTerm(term, min, max);
    if (expanded === null) return null;
    for (const value of expanded) values.add(value);
  }
  if (values.size === 0) return null;
  return [...values].sort((a, b) => a - b);
}

function parseCronExpression(schedule: string): ParsedCron | null {
  if (typeof schedule !== "string") return null;
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const daysOfMonth = parseField(dayOfMonthField, 1, 31);
  const months = parseField(monthField, 1, 12);
  // 7 is a second spelling of Sunday.
  const rawDaysOfWeek = parseField(dayOfWeekField, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: [...new Set(rawDaysOfWeek.map((d) => d % 7))].sort((a, b) => a - b),
    dayOfMonthRestricted: dayOfMonthField !== "*",
    dayOfWeekRestricted: dayOfWeekField !== "*",
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // Throws RangeError on an unknown zone; `nextFireAtMs` turns that into `null`.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Wall-clock parts of an instant, plus seconds (needed to invert the zone offset). */
function partsAt(
  timestampMs: number,
  timeZone: string | undefined,
): (WallClock & { readonly second: number }) | null {
  if (!Number.isFinite(timestampMs)) return null;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return null;

  if (timeZone === undefined) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }

  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  const wall = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
  return Object.values(wall).some((value) => Number.isNaN(value)) ? null : wall;
}

/** The zone's UTC offset at an instant, derived by reading the wall clock back. */
function offsetMsAt(timestampMs: number, timeZone: string): number | null {
  const parts = partsAt(timestampMs, timeZone);
  if (parts === null) return null;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(timestampMs / 1000) * 1000;
}

/**
 * The instant a wall-clock minute names, or `null` when it names none.
 *
 * `null` is the spring-forward gap: 02:30 simply does not happen on that date, and a job
 * scheduled for it does not run that day. Ambiguous minutes (the fall-back repeat) resolve
 * to the first occurrence, which is what every cron implementation does.
 */
function timestampFor(wall: WallClock, timeZone: string | undefined): number | null {
  if (timeZone === undefined) {
    const date = new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
    const timestampMs = date.getTime();
    if (Number.isNaN(timestampMs)) return null;
    // A shifted result means the wall-clock minute does not exist in this zone.
    return date.getFullYear() === wall.year &&
      date.getMonth() === wall.month - 1 &&
      date.getDate() === wall.day &&
      date.getHours() === wall.hour &&
      date.getMinutes() === wall.minute
      ? timestampMs
      : null;
  }

  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  if (Number.isNaN(asUtc)) return null;

  // Guess with the offset at the naive instant, then re-derive it at the guess so a
  // transition between the two is corrected.
  const firstOffset = offsetMsAt(asUtc, timeZone);
  if (firstOffset === null) return null;
  const guess = asUtc - firstOffset;
  const secondOffset = offsetMsAt(guess, timeZone);
  if (secondOffset === null) return null;
  const timestampMs = asUtc - secondOffset;

  const check = partsAt(timestampMs, timeZone);
  if (check === null) return null;
  return check.year === wall.year &&
    check.month === wall.month &&
    check.day === wall.day &&
    check.hour === wall.hour &&
    check.minute === wall.minute
    ? timestampMs
    : null;
}

function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function nextCalendarDay(year: number, month: number, day: number): WallClock {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

function dayMatches(parsed: ParsedCron, year: number, month: number, day: number): boolean {
  if (!parsed.months.includes(month)) return false;
  const dayOfMonthHit = parsed.daysOfMonth.includes(day);
  const dayOfWeekHit = parsed.daysOfWeek.includes(dayOfWeek(year, month, day));
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) {
    return dayOfMonthHit || dayOfWeekHit;
  }
  if (parsed.dayOfMonthRestricted) return dayOfMonthHit;
  if (parsed.dayOfWeekRestricted) return dayOfWeekHit;
  return true;
}

/**
 * The next instant `schedule` fires, strictly after `nowMs`, or `null`.
 *
 * `null` covers every failure — an expression outside the producer's grammar, an unknown
 * `timeZone`, a nonsensical `nowMs`, or no match inside the search horizon. It never
 * throws, because this runs inside a provider hook callback where a thrown error would cost
 * the user a turn.
 *
 * `timeZone` is an IANA zone name; omitted, the server's local zone is used, which is what
 * the producer means by "local time" (the binary and the server share a process group).
 *
 * A recurring entry's period — needed for the derived wake grace — is the gap between two
 * successive fires: `nextFireAtMs(s, nextFireAtMs(s, now)!)`. See `periodMsAfter`.
 */
export function nextFireAtMs(schedule: string, nowMs: number, timeZone?: string): number | null {
  try {
    if (!Number.isFinite(nowMs)) return null;
    const parsed = parseCronExpression(schedule);
    if (parsed === null) return null;

    const start = partsAt(nowMs, timeZone);
    if (start === null) return null;

    let cursor: WallClock = start;
    for (let dayIndex = 0; dayIndex < MAX_SEARCH_DAYS; dayIndex++) {
      if (dayMatches(parsed, cursor.year, cursor.month, cursor.day)) {
        const isStartDay = dayIndex === 0;
        for (const hour of parsed.hours) {
          if (isStartDay && hour < start.hour) continue;
          for (const minute of parsed.minutes) {
            if (isStartDay && hour === start.hour && minute < start.minute) continue;
            const timestampMs = timestampFor(
              { year: cursor.year, month: cursor.month, day: cursor.day, hour, minute },
              timeZone,
            );
            // `> nowMs`, not `>=`: the match must be strictly in the future, and on a
            // fall-back day the first candidate can resolve to an instant already past.
            if (timestampMs !== null && timestampMs > nowMs) return timestampMs;
          }
        }
      }
      cursor = nextCalendarDay(cursor.year, cursor.month, cursor.day);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The gap to the fire after `fromMs`'s next one — the `periodMs` the derived wake grace
 * scales with. `null` whenever either fire is unknown.
 */
export function periodMsAfter(schedule: string, fromMs: number, timeZone?: string): number | null {
  const first = nextFireAtMs(schedule, fromMs, timeZone);
  if (first === null) return null;
  const second = nextFireAtMs(schedule, first, timeZone);
  return second === null ? null : second - first;
}
