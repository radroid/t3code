// @effect-diagnostics globalDate:off - the expectations are built from explicit calendar values.
import { describe, expect, it } from "vite-plus/test";

import { nextFireAtMs, periodMsAfter } from "./parse.ts";

const utc = (iso: string) => Date.parse(iso);
const NY = "America/New_York";

// Every case here is TESTS 70b: the SDK delivers no timestamp for a cron entry, so this
// parse is the whole of the deference risk. `null` always means "no deference from this
// entry" — never "defer forever" — so the rejection cases matter as much as the matches.
describe("nextFireAtMs — recurring forms (70b)", () => {
  it("70b — a step expression yields the next match strictly after now", () => {
    expect(nextFireAtMs("*/5 * * * *", utc("2026-03-01T10:02:30Z"), "UTC")).toBe(
      utc("2026-03-01T10:05:00Z"),
    );
  });

  it("70b — at exactly a matching minute the NEXT match is returned, not now", () => {
    expect(nextFireAtMs("*/5 * * * *", utc("2026-03-01T10:05:00.000Z"), "UTC")).toBe(
      utc("2026-03-01T10:10:00Z"),
    );
  });

  it("70b — a daily expression rolls over to tomorrow once today's fire has passed", () => {
    expect(nextFireAtMs("0 3 * * *", utc("2026-03-01T04:00:00Z"), "UTC")).toBe(
      utc("2026-03-02T03:00:00Z"),
    );
  });

  it("70b — a day-of-week range skips the weekend", () => {
    // 2026-03-06 is a Friday; the next weekday 09:00 is Monday the 9th.
    expect(nextFireAtMs("0 9 * * 1-5", utc("2026-03-06T10:00:00Z"), "UTC")).toBe(
      utc("2026-03-09T09:00:00Z"),
    );
  });

  it("70b — a comma list picks the earliest listed value", () => {
    expect(nextFireAtMs("0 0,12 * * *", utc("2026-03-01T06:00:00Z"), "UTC")).toBe(
      utc("2026-03-01T12:00:00Z"),
    );
  });

  it("70b — a stepped range expands to its members and no further", () => {
    // 9-17/4 is 09:00, 13:00, 17:00 — 21:00 is outside the range.
    expect(nextFireAtMs("0 9-17/4 * * *", utc("2026-03-01T13:30:00Z"), "UTC")).toBe(
      utc("2026-03-01T17:00:00Z"),
    );
    expect(nextFireAtMs("0 9-17/4 * * *", utc("2026-03-01T17:30:00Z"), "UTC")).toBe(
      utc("2026-03-02T09:00:00Z"),
    );
  });

  it("70b — 7 is Sunday, the same day as 0", () => {
    // 2026-03-01 is a Sunday.
    expect(nextFireAtMs("0 6 * * 7", utc("2026-02-28T12:00:00Z"), "UTC")).toBe(
      utc("2026-03-01T06:00:00Z"),
    );
  });

  it("70b — restricting BOTH day fields is a union, not an intersection", () => {
    // "the 1st, and every Monday". 2026-03-02 is a Monday, 2026-04-01 a Wednesday.
    expect(nextFireAtMs("0 9 1 * 1", utc("2026-03-01T12:00:00Z"), "UTC")).toBe(
      utc("2026-03-02T09:00:00Z"),
    );
    expect(nextFireAtMs("0 9 1 * 1", utc("2026-03-31T12:00:00Z"), "UTC")).toBe(
      utc("2026-04-01T09:00:00Z"),
    );
  });
});

describe("nextFireAtMs — the one-shot form (70b)", () => {
  it("70b — a one-shot's five fields resolve to exactly the instant they encode", () => {
    // What `ScheduleWakeup` produces: every field concrete, day-of-week open.
    expect(nextFireAtMs("35 2 15 9 *", utc("2026-09-15T00:10:00Z"), "UTC")).toBe(
      utc("2026-09-15T02:35:00Z"),
    );
  });

  it("70b — a one-shot recorded seconds before it fires still resolves to that instant", () => {
    expect(nextFireAtMs("35 2 15 9 *", utc("2026-09-15T02:34:59Z"), "UTC")).toBe(
      utc("2026-09-15T02:35:00Z"),
    );
  });

  it("70b — a one-shot already in the past resolves a year out, which is why the value is computed at hook time", () => {
    // Documented behaviour, not a bug: `crons.ts` computes and persists `nextFireAtMs` when
    // the entry is observed. A past wake is detected from the PERSISTED value, and re-parsing
    // one on a later tick would silently turn a lost wake into next year's commitment — well
    // beyond any deadline, so guard 10b declines to defer to it either way.
    expect(nextFireAtMs("35 2 15 9 *", utc("2026-09-15T03:00:00Z"), "UTC")).toBe(
      utc("2027-09-15T02:35:00Z"),
    );
  });
});

describe("nextFireAtMs — outside the producer's grammar (70b)", () => {
  const rejected = [
    ["four fields", "0 3 * *"],
    ["six fields (a seconds column)", "0 0 3 * * *"],
    ["a macro", "@daily"],
    ["a month name", "0 3 * JAN *"],
    ["a weekday name", "0 3 * * MON"],
    ["a bare stepped value", "5/2 * * * *"],
    ["a wrap-around range", "0 22-2 * * *"],
    ["a minute out of range", "60 * * * *"],
    ["a day-of-week out of range", "0 3 * * 8"],
    ["a month out of range", "0 3 * 13 *"],
    ["a zero step", "*/0 * * * *"],
    ["an empty term", "0,, 3 * * *"],
    ["a negative value", "-1 3 * * *"],
    ["an empty expression", ""],
    ["whitespace only", "   "],
    ["a last-Sunday extension", "0 3 * * 0L"],
    ["a nearest-weekday extension", "0 3 15W * *"],
  ] as const;

  for (const [label, schedule] of rejected) {
    it(`70b — ${label} yields null, which means no deference rather than deferring forever`, () => {
      expect(nextFireAtMs(schedule, utc("2026-03-01T00:00:00Z"), "UTC")).toBeNull();
    });
  }

  it("70b — an expression that can never match returns null instead of searching forever", () => {
    expect(nextFireAtMs("0 0 30 2 *", utc("2026-03-01T00:00:00Z"), "UTC")).toBeNull();
  });

  it("70b — an unknown timezone returns null and does not throw into the hook callback", () => {
    expect(nextFireAtMs("0 3 * * *", utc("2026-03-01T00:00:00Z"), "Mars/Olympus_Mons")).toBeNull();
  });

  it("70b — a nonsense `nowMs` returns null rather than throwing", () => {
    expect(nextFireAtMs("0 3 * * *", Number.NaN, "UTC")).toBeNull();
    expect(nextFireAtMs("0 3 * * *", Number.POSITIVE_INFINITY, "UTC")).toBeNull();
  });

  it("70b — hostile input returns null rather than throwing", () => {
    expect(nextFireAtMs("*".repeat(10_000), utc("2026-03-01T00:00:00Z"), "UTC")).toBeNull();
    expect(nextFireAtMs("🕐 🕑 🕒 🕓 🕔", utc("2026-03-01T00:00:00Z"), "UTC")).toBeNull();
  });
});

// A cron expression names a WALL CLOCK, so a correct parse keeps the local time fixed across
// a transition and lets the UTC offset move. These are the cases that separate a real parse
// from `now + period` arithmetic, which drifts by an hour twice a year and would fire
// `wake_lost` — the strongest trigger in the design — on a perfectly healthy thread.
describe("nextFireAtMs — daylight saving (70b)", () => {
  it("70b — a daily wake keeps its local hour across spring forward", () => {
    // 09:00 EST is 14:00Z on the Saturday; 09:00 EDT is 13:00Z on the Monday.
    const saturday = nextFireAtMs("0 9 * * *", utc("2026-03-07T00:00:00Z"), NY);
    expect(saturday).toBe(utc("2026-03-07T14:00:00Z"));
    const monday = nextFireAtMs("0 9 * * *", utc("2026-03-08T20:00:00Z"), NY);
    expect(monday).toBe(utc("2026-03-09T13:00:00Z"));
  });

  it("70b — a wake inside the spring-forward gap is skipped, not shifted", () => {
    // On 2026-03-08 the clock jumps 01:59 -> 03:00, so 02:30 never happens that day; the
    // next 02:30 is on the 9th (06:30Z, EDT).
    expect(nextFireAtMs("30 2 * * *", utc("2026-03-07T12:00:00Z"), NY)).toBe(
      utc("2026-03-09T06:30:00Z"),
    );
  });

  it("70b — a wake on the far side of the gap fires at the correct instant", () => {
    expect(nextFireAtMs("0 3 * * *", utc("2026-03-08T05:00:00Z"), NY)).toBe(
      utc("2026-03-08T07:00:00Z"),
    );
  });

  it("70b — an ambiguous wall clock on fall-back resolves to its first occurrence", () => {
    // 2026-11-01 01:30 happens twice: 05:30Z (EDT) and 06:30Z (EST).
    expect(nextFireAtMs("30 1 * * *", utc("2026-10-31T12:00:00Z"), NY)).toBe(
      utc("2026-11-01T05:30:00Z"),
    );
  });
});

describe("nextFireAtMs — calendar boundaries (70b)", () => {
  it("70b — day 31 skips the months that do not have one", () => {
    expect(nextFireAtMs("0 0 31 * *", utc("2026-01-31T12:00:00Z"), "UTC")).toBe(
      utc("2026-03-31T00:00:00Z"),
    );
  });

  it("70b — 29 February resolves to the next leap year", () => {
    expect(nextFireAtMs("0 12 29 2 *", utc("2026-03-01T00:00:00Z"), "UTC")).toBe(
      utc("2028-02-29T12:00:00Z"),
    );
  });

  it("70b — the last minute of the year rolls into the next one", () => {
    expect(nextFireAtMs("*/30 * * * *", utc("2026-12-31T23:45:00Z"), "UTC")).toBe(
      utc("2027-01-01T00:00:00Z"),
    );
  });
});

describe("nextFireAtMs — the server's local zone (70b)", () => {
  it("70b — omitting the timezone evaluates in local time, as the tool documents", () => {
    // Built from the local calendar so the assertion holds under any machine TZ.
    const now = new Date(2026, 5, 10, 14, 20, 0, 0).getTime();
    const expected = new Date(2026, 5, 10, 15, 0, 0, 0).getTime();
    expect(nextFireAtMs("0 * * * *", now, undefined)).toBe(expected);
  });
});

describe("periodMsAfter (70b)", () => {
  it("70b — the period of a recurring wake is the gap between two successive fires", () => {
    expect(periodMsAfter("*/15 * * * *", utc("2026-03-01T00:00:00Z"), "UTC")).toBe(15 * 60_000);
    expect(periodMsAfter("0 3 * * *", utc("2026-03-01T00:00:00Z"), "UTC")).toBe(24 * 3_600_000);
  });

  it("70b — a daily period across spring forward is 23 hours, so the derived grace shrinks with it", () => {
    expect(periodMsAfter("0 9 * * *", utc("2026-03-07T00:00:00Z"), NY)).toBe(23 * 3_600_000);
  });

  it("70b — an unparseable schedule has no period", () => {
    expect(periodMsAfter("@daily", utc("2026-03-01T00:00:00Z"), "UTC")).toBeNull();
  });
});
