// Tests for lib/format.mjs.
//
// The DST cases run in child processes with TZ pinned, so they assert the same thing no matter
// which timezone the developer's machine is in — and so a timezone change cannot leak between
// tests. Everything else must hold in any zone and runs in-process.

import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";

import {
  dayWindow,
  eachDay,
  formatDuration,
  formatHours,
  formatLocalDate,
  formatNumber,
  localDayKey,
  parseIso,
  parseLocalDate,
  pluralize,
  rangeWindow,
  timezoneName,
  toIso,
} from "../lib/format.mjs";

const MODULE_URL = new URL("../lib/format.mjs", import.meta.url).href;

/** Runs a snippet against lib/format.mjs in a child process with TZ pinned, returning its JSON. */
function inTimeZone(timeZone, body, extraEnv = {}) {
  const source = [
    `import * as format from ${JSON.stringify(MODULE_URL)};`,
    `const result = (() => { ${body} })();`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");

  const run = NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, TZ: timeZone, ...extraEnv },
  });
  NodeAssert.equal(run.status, 0, `child process failed under TZ=${timeZone}:\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

// ICU resolves a handful of zone names to their older canonical link, so "TZ took effect" is
// checked against the alias rather than the literal name we asked for.
const ZONE_ALIASES = new Map([["Asia/Kolkata", "Asia/Calcutta"]]);

/** True when a resolved IANA zone name is the requested zone or its canonical alias. */
function zoneMatches(observed, requested) {
  return observed === requested || observed === ZONE_ALIASES.get(requested);
}

// Verified against the tz database on 2026-08-10: Toronto loses an hour on 2026-03-08 and gains
// one on 2026-11-01; Santiago springs forward AT midnight, so 2026-09-06T00:00 local does not
// exist at all; Lord Howe shifts by 30 minutes, giving 23.5h and 24.5h days.
const DST_CASES = [
  { timeZone: "America/Toronto", day: "2026-03-08", next: "2026-03-09", hours: 23 },
  { timeZone: "America/Toronto", day: "2026-11-01", next: "2026-11-02", hours: 25 },
  { timeZone: "America/Santiago", day: "2026-09-06", next: "2026-09-07", hours: 23 },
  { timeZone: "Pacific/Auckland", day: "2026-04-05", next: "2026-04-06", hours: 25 },
  { timeZone: "Australia/Lord_Howe", day: "2026-04-05", next: "2026-04-06", hours: 24.5 },
  { timeZone: "Australia/Lord_Howe", day: "2026-10-04", next: "2026-10-05", hours: 23.5 },
  { timeZone: "UTC", day: "2026-03-08", next: "2026-03-09", hours: 24 },
  { timeZone: "Asia/Kolkata", day: "2026-03-08", next: "2026-03-09", hours: 24 },
];

NodeTest.test("parseLocalDate returns local midnight for a real calendar date", () => {
  for (const day of ["2026-08-10", "2026-01-01", "2026-12-31", "2024-02-29", "1999-06-30"]) {
    NodeAssert.equal(formatLocalDate(parseLocalDate(day)), day);
  }
  const date = parseLocalDate(" 2026-05-05 ");
  NodeAssert.equal(formatLocalDate(date), "2026-05-05");
  NodeAssert.equal(date.getMinutes(), 0);
  NodeAssert.equal(date.getSeconds(), 0);
  NodeAssert.equal(date.getMilliseconds(), 0);
});

NodeTest.test("parseLocalDate rejects impossible calendar dates", () => {
  for (const day of [
    "2026-02-31",
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
  ]) {
    NodeAssert.throws(() => parseLocalDate(day), TypeError, `${day} should be rejected`);
  }
});

NodeTest.test("parseLocalDate rejects malformed input", () => {
  for (const value of [
    "",
    "   ",
    "2026-1-1",
    "20260101",
    "2026/01/01",
    "today",
    "2026-08-10T00:00:00Z",
  ]) {
    NodeAssert.throws(
      () => parseLocalDate(value),
      TypeError,
      `${JSON.stringify(value)} should be rejected`,
    );
  }
  for (const value of [null, undefined, 20260810, new Date(), ["2026-08-10"]]) {
    NodeAssert.throws(() => parseLocalDate(value), TypeError);
  }
});

NodeTest.test("formatLocalDate pads and accepts Date, epoch ms, or ISO string", () => {
  const date = new Date(2026, 0, 5, 13, 45);
  NodeAssert.equal(formatLocalDate(date), "2026-01-05");
  NodeAssert.equal(formatLocalDate(date.getTime()), "2026-01-05");
  NodeAssert.equal(formatLocalDate(date.toISOString()), "2026-01-05");
  NodeAssert.throws(() => formatLocalDate("nonsense"), TypeError);
  NodeAssert.throws(() => formatLocalDate(new Date(Number.NaN)), TypeError);
});

NodeTest.test("localDayKey is the forgiving variant: null instead of a throw", () => {
  const date = new Date(2026, 7, 10, 23, 59, 59);
  NodeAssert.equal(localDayKey(date), "2026-08-10");
  NodeAssert.equal(localDayKey(date.getTime()), "2026-08-10");
  NodeAssert.equal(localDayKey(date.toISOString()), "2026-08-10");

  for (const value of [null, undefined, "", "   ", "nonsense", Number.NaN, {}, 1e21]) {
    NodeAssert.equal(localDayKey(value), null, `${String(value)} should have no day key`);
  }
});

NodeTest.test("dayWindow ends at the next calendar date's midnight", () => {
  for (const [day, next] of [
    ["2026-08-10", "2026-08-11"],
    ["2026-01-31", "2026-02-01"],
    ["2026-12-31", "2027-01-01"],
    ["2024-02-28", "2024-02-29"],
    ["2024-02-29", "2024-03-01"],
  ]) {
    const { start, end } = dayWindow(day);
    NodeAssert.equal(formatLocalDate(start), day);
    NodeAssert.equal(formatLocalDate(end), next, `${day} should end on ${next}`);
    NodeAssert.equal(end.getTime(), dayWindow(next).start.getTime());
    NodeAssert.ok(end.getTime() > start.getTime());
  }
});

NodeTest.test("dayWindow is a calendar day, not 86_400_000 ms, across every DST shape", () => {
  for (const { timeZone, day, next, hours } of DST_CASES) {
    const observed = inTimeZone(
      timeZone,
      `
      const window = format.dayWindow(${JSON.stringify(day)});
      return {
        startKey: format.formatLocalDate(window.start),
        endKey: format.formatLocalDate(window.end),
        startHour: window.start.getHours(),
        endHour: window.end.getHours(),
        endMinute: window.end.getMinutes(),
        hours: (window.end.getTime() - window.start.getTime()) / 3600000,
        naiveEndKey: format.formatLocalDate(window.start.getTime() + 86400000),
        naiveHour: new Date(window.start.getTime() + 86400000).getHours(),
        naiveMinute: new Date(window.start.getTime() + 86400000).getMinutes(),
        matchesNextDayStart:
          window.end.getTime() === format.dayWindow(${JSON.stringify(next)}).start.getTime(),
        zone: format.timezoneName(),
      };
    `,
    );

    const label = `${timeZone} ${day}`;
    NodeAssert.ok(zoneMatches(observed.zone, timeZone), `${label}: TZ did not take effect`);
    NodeAssert.equal(observed.startKey, day, `${label}: window starts on the wrong day`);
    NodeAssert.equal(observed.endKey, next, `${label}: window ends on the wrong day`);
    NodeAssert.equal(observed.hours, hours, `${label}: window is the wrong length`);
    NodeAssert.equal(observed.matchesNextDayStart, true, `${label}: windows do not tile`);
    NodeAssert.equal(observed.endHour, 0, `${label}: window must end at midnight`);
    NodeAssert.equal(observed.endMinute, 0, `${label}: window must end at midnight`);

    // And the whole point: what `start + 86_400_000` would have produced instead.
    const naiveIsMidnight = observed.naiveHour === 0 && observed.naiveMinute === 0;
    if (hours === 24) {
      NodeAssert.equal(observed.naiveEndKey, next, `${label}`);
      NodeAssert.ok(naiveIsMidnight, `${label}`);
    } else if (hours > 24) {
      // A long day: 24h lands back inside the same date, so the tail of the day is dropped.
      NodeAssert.equal(observed.naiveEndKey, day, `${label}: naive end stays inside the day`);
      NodeAssert.ok(!naiveIsMidnight, `${label}`);
    } else {
      // A short day: 24h overshoots past midnight into the next day, double-counting it.
      NodeAssert.equal(observed.naiveEndKey, next, `${label}: naive end spills into the next day`);
      NodeAssert.ok(!naiveIsMidnight, `${label}: naive end should miss midnight`);
    }
  }
});

NodeTest.test(
  "a spring-forward day whose local midnight does not exist still keys correctly",
  () => {
    const observed = inTimeZone(
      "America/Santiago",
      `
    const window = format.dayWindow("2026-09-06");
    return {
      startHour: window.start.getHours(),
      startKey: format.formatLocalDate(window.start),
      naive: format.formatLocalDate(window.start.getTime() + 86400000),
      endKey: format.formatLocalDate(window.end),
    };
  `,
    );
    NodeAssert.equal(observed.startHour, 1, "Santiago skips 00:00 on this date");
    NodeAssert.equal(observed.startKey, "2026-09-06");
    NodeAssert.equal(observed.endKey, "2026-09-07");
    NodeAssert.equal(observed.naive, "2026-09-07", "naive arithmetic lands at 01:00, not midnight");
  },
);

NodeTest.test(
  "a calendar date that never existed locally is rejected, and skipped by eachDay",
  () => {
    // Samoa jumped the date line at the end of 2011: 2011-12-30 simply never happened there.
    // Kiritimati did the same on 1994-12-31. `new Date` silently hands back the following day,
    // so only the day-of-month round-trip catches it.
    const samoa = inTimeZone(
      "Pacific/Apia",
      `
    let rejected = false;
    try { format.parseLocalDate("2011-12-30"); } catch (error) { rejected = error instanceof TypeError; }
    return { rejected, days: format.eachDay("2011-12-29", "2012-01-01") };
  `,
    );
    NodeAssert.equal(samoa.rejected, true, "2011-12-30 did not exist in Samoa");
    NodeAssert.deepEqual(samoa.days, ["2011-12-29", "2011-12-31", "2012-01-01"]);

    const kiritimati = inTimeZone(
      "Pacific/Kiritimati",
      `
    let rejected = false;
    try { format.parseLocalDate("1994-12-31"); } catch (error) { rejected = error instanceof TypeError; }
    return { rejected, days: format.eachDay("1994-12-30", "1995-01-01") };
  `,
    );
    NodeAssert.equal(kiritimati.rejected, true, "1994-12-31 did not exist on Kiritimati");
    NodeAssert.deepEqual(kiritimati.days, ["1994-12-30", "1995-01-01"]);
  },
);

NodeTest.test("localDayKey buckets UTC timestamps by the local day boundary", () => {
  const observed = inTimeZone(
    "America/Toronto",
    `
    return [
      format.localDayKey("2026-03-08T04:59:00.000Z"),
      format.localDayKey("2026-03-08T05:00:00.000Z"),
      format.localDayKey("2026-08-11T03:59:59.999Z"),
      format.localDayKey("2026-08-11T04:00:00.000Z"),
    ];
  `,
  );
  NodeAssert.deepEqual(observed, ["2026-03-07", "2026-03-08", "2026-08-10", "2026-08-11"]);
});

NodeTest.test("eachDay is inclusive and crosses month, year, and leap boundaries", () => {
  NodeAssert.deepEqual(eachDay("2026-08-10", "2026-08-10"), ["2026-08-10"]);
  NodeAssert.deepEqual(eachDay("2026-08-30", "2026-09-02"), [
    "2026-08-30",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
  ]);
  NodeAssert.deepEqual(eachDay("2026-12-30", "2027-01-02"), [
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
  ]);
  NodeAssert.deepEqual(eachDay("2024-02-27", "2024-03-01"), [
    "2024-02-27",
    "2024-02-28",
    "2024-02-29",
    "2024-03-01",
  ]);
  NodeAssert.equal(eachDay("2026-01-01", "2026-12-31").length, 365);
  NodeAssert.equal(eachDay("2024-01-01", "2024-12-31").length, 366);
});

NodeTest.test("eachDay throws when the range runs backwards", () => {
  NodeAssert.throws(() => eachDay("2026-08-11", "2026-08-10"), RangeError);
  NodeAssert.throws(() => rangeWindow("2026-08-11", "2026-08-10"), RangeError);
  NodeAssert.throws(() => eachDay("2026-08-10", "not-a-date"), TypeError);
});

NodeTest.test("eachDay never skips or repeats a day, in any DST zone", () => {
  for (const timeZone of ["America/Toronto", "America/Santiago", "Australia/Lord_Howe", "UTC"]) {
    const observed = inTimeZone(
      timeZone,
      `
      const days = format.eachDay("2026-01-01", "2026-12-31");
      return { count: days.length, unique: new Set(days).size, first: days[0], last: days.at(-1) };
    `,
    );
    NodeAssert.deepEqual(
      observed,
      { count: 365, unique: 365, first: "2026-01-01", last: "2026-12-31" },
      `${timeZone} produced a broken year`,
    );
  }
});

NodeTest.test("rangeWindow spans midnight to midnight and lists its days", () => {
  const range = rangeWindow("2026-08-08", "2026-08-10");
  NodeAssert.deepEqual(range.days, ["2026-08-08", "2026-08-09", "2026-08-10"]);
  NodeAssert.equal(range.start.getTime(), dayWindow("2026-08-08").start.getTime());
  NodeAssert.equal(range.end.getTime(), dayWindow("2026-08-10").end.getTime());
  NodeAssert.equal(formatLocalDate(range.end), "2026-08-11");

  const single = rangeWindow("2026-08-10", "2026-08-10");
  NodeAssert.deepEqual(single.days, ["2026-08-10"]);
  NodeAssert.deepEqual(
    { start: single.start.getTime(), end: single.end.getTime() },
    { start: dayWindow("2026-08-10").start.getTime(), end: dayWindow("2026-08-10").end.getTime() },
  );
});

NodeTest.test("formatDuration rounds down and never wraps hours into days", () => {
  const cases = [
    [0, "0m"],
    [-5000, "0m"],
    [500, "0m"],
    [999, "0m"],
    [1000, "1s"],
    [35_000, "35s"],
    [35_999, "35s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [2_880_000, "48m"],
    [3_599_999, "59m"],
    [3_600_000, "1h"],
    [15_120_000, "4h 12m"],
    [15_179_999, "4h 12m"],
    [86_400_000, "24h"],
    [111_900_000, "31h 5m"],
    [Number.NaN, "0m"],
    [Number.POSITIVE_INFINITY, "0m"],
    [undefined, "0m"],
    [null, "0m"],
    ["not a number", "0m"],
  ];
  for (const [ms, expected] of cases) {
    NodeAssert.equal(formatDuration(ms), expected, `formatDuration(${String(ms)})`);
  }
});

NodeTest.test("formatHours reports one decimal place", () => {
  NodeAssert.equal(formatHours(15_120_000), "4.2h");
  NodeAssert.equal(formatHours(3_600_000), "1.0h");
  NodeAssert.equal(formatHours(111_900_000), "31.1h");
  NodeAssert.equal(formatHours(60_000), "0.0h");
  NodeAssert.equal(formatHours(0), "0.0h");
  NodeAssert.equal(formatHours(-1), "0.0h");
  NodeAssert.equal(formatHours(Number.NaN), "0.0h");
  NodeAssert.equal(formatHours(undefined), "0.0h");
});

NodeTest.test("formatNumber groups thousands regardless of machine locale", () => {
  NodeAssert.equal(formatNumber(0), "0");
  NodeAssert.equal(formatNumber(999), "999");
  NodeAssert.equal(formatNumber(1234), "1,234");
  NodeAssert.equal(formatNumber(1_234_567), "1,234,567");
  NodeAssert.equal(formatNumber(-1234), "-1,234");
  NodeAssert.equal(formatNumber("2500"), "2,500");
  NodeAssert.equal(formatNumber(Number.NaN), "0");
  NodeAssert.equal(formatNumber(Number.POSITIVE_INFINITY), "0");
  NodeAssert.equal(formatNumber(undefined), "0");

  // Under a German locale the platform default would be "1.234.567,5"; the pinned formatter
  // must not follow it, or a report's numbers would change shape with the shell environment.
  const german = inTimeZone(
    "UTC",
    "return { pinned: format.formatNumber(1234567.5), platform: (1234567.5).toLocaleString() };",
    { LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" },
  );
  NodeAssert.equal(german.platform, "1.234.567,5", "the child did not actually pick up the locale");
  NodeAssert.equal(german.pinned, "1,234,567.5");
});

NodeTest.test("pluralize returns the word only", () => {
  NodeAssert.equal(pluralize(1, "commit"), "commit");
  NodeAssert.equal(pluralize(0, "commit"), "commits");
  NodeAssert.equal(pluralize(2, "commit"), "commits");
  NodeAssert.equal(pluralize(-1, "commit"), "commit");
  NodeAssert.equal(pluralize(1, "entry", "entries"), "entry");
  NodeAssert.equal(pluralize(3, "entry", "entries"), "entries");
  NodeAssert.equal(pluralize(Number.NaN, "session"), "sessions");
});

NodeTest.test("timezoneName reports the IANA zone", () => {
  const name = timezoneName();
  NodeAssert.equal(typeof name, "string");
  NodeAssert.ok(name.length > 0);
  NodeAssert.equal(
    inTimeZone("America/Toronto", "return format.timezoneName();"),
    "America/Toronto",
  );
  NodeAssert.equal(inTimeZone("UTC", "return format.timezoneName();"), "UTC");
  // Documented quirk: the reported zone is ICU's canonical name, which for a few zones is the
  // older link. The bundle header inherits that, and that is fine — it is still unambiguous.
  NodeAssert.ok(
    zoneMatches(inTimeZone("Asia/Kolkata", "return format.timezoneName();"), "Asia/Kolkata"),
  );
});

NodeTest.test("toIso normalises every accepted timestamp shape and is null-safe", () => {
  // The exact shape T3code stores in projection_threads.created_at.
  NodeAssert.equal(toIso("2026-03-20T18:35:07.854Z"), "2026-03-20T18:35:07.854Z");
  NodeAssert.equal(toIso(new Date(0)), "1970-01-01T00:00:00.000Z");
  NodeAssert.equal(toIso(1_770_000_000_000), new Date(1_770_000_000_000).toISOString());
  NodeAssert.equal(toIso("2026-08-10T12:00:00-04:00"), "2026-08-10T16:00:00.000Z");

  for (const value of [null, undefined, "", "   ", "nonsense", Number.NaN, 1e21, {}, []]) {
    NodeAssert.equal(toIso(value), null, `${String(value)} should not produce an ISO string`);
  }
});

NodeTest.test("parseIso returns epoch milliseconds or null", () => {
  NodeAssert.equal(parseIso("2026-03-20T18:35:07.854Z"), Date.parse("2026-03-20T18:35:07.854Z"));
  NodeAssert.equal(parseIso(new Date(1234)), 1234);
  NodeAssert.equal(parseIso(5678), 5678);
  // A bare 13-digit stamp is epoch ms, which Date.parse alone would reject.
  NodeAssert.equal(parseIso("1770000000000"), 1_770_000_000_000);
  // A short digit run stays a year, per Date.parse's ISO rules.
  NodeAssert.equal(parseIso("1999"), Date.UTC(1999, 0, 1));

  for (const value of [null, undefined, "", "nonsense", Number.NaN, {}]) {
    NodeAssert.equal(parseIso(value), null, `${String(value)} should not parse`);
  }
});

NodeTest.test("toIso and parseIso round-trip", () => {
  const iso = "2026-08-10T14:22:03.001Z";
  NodeAssert.equal(toIso(parseIso(iso)), iso);
  NodeAssert.equal(parseIso(toIso(parseIso(iso))), Date.parse(iso));
});
