// Run with: node --test scripts/t3x/worklog/test/timeline.test.mjs
//
// Every day boundary here is LOCAL, so the suite pins a zone with a known DST profile rather than
// trusting the machine's. Node applies a runtime TZ change, but if a platform ever refuses, the
// zone-specific assertions skip instead of failing for the wrong reason.
process.env.TZ = "America/Toronto";

import assert from "node:assert/strict";
import test from "node:test";

import {
  activeMs,
  activeTimeline,
  agentRuntimeMs,
  buildBlocks,
  clipInterval,
  mergeIntervals,
  splitByDay,
  sumIntervals,
  toMs,
} from "../lib/timeline.mjs";

const TZ_PINNED = new Date(2026, 0, 1).getTimezoneOffset() === 300;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GAP = 30 * MINUTE;
const SINGLE = 1 * MINUTE;

// Mon 2026-08-10, a plain 24-hour local day.
const DAY_KEY = "2026-08-10";
const DAY_START = new Date(2026, 7, 10).getTime();
const DAY_END = new Date(2026, 7, 11).getTime();
const DAY_MS = DAY_END - DAY_START;
const WINDOW = { start: DAY_START, end: DAY_END };

/** Local instant on 2026-08-10 as an ISO string, the shape the collector reads out of SQLite. */
function at(hour, minute = 0, second = 0) {
  return new Date(2026, 7, 10, hour, minute, second).toISOString();
}

/** Deterministic shuffle so "input arrives unsorted" is a real condition, not a lucky ordering. */
function shuffled(values) {
  const copy = [...values];
  let seed = 1337;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const swap = seed % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

test("toMs accepts Dates, ISO strings and epoch numbers, and refuses everything else", () => {
  const iso = "2026-08-10T14:30:00.000Z";
  const ms = Date.parse(iso);

  assert.equal(toMs(new Date(ms)), ms);
  assert.equal(toMs(iso), ms);
  assert.equal(toMs("2026-08-10T10:30:00.000-04:00"), ms);
  assert.equal(toMs(`  ${iso}  `), ms);
  assert.equal(toMs(ms), ms);
  assert.equal(toMs(String(ms)), ms, "a bare epoch string is a stamp, not a year");
  assert.equal(toMs(0), 0, "the epoch itself is a real instant, not falsy input");

  for (const bad of [
    null,
    undefined,
    "",
    "   ",
    "not a date",
    "20260810",
    NaN,
    Infinity,
    {},
    [],
    true,
    new Date("nope"),
  ]) {
    assert.equal(toMs(bad), null, `expected null for ${String(bad)}`);
  }
});

test("clipInterval intersects with the window and treats a touch as empty", () => {
  const interval = { start: at(9), end: at(11) };

  assert.deepEqual(clipInterval(interval, { start: at(8), end: at(12) }), {
    start: Date.parse(at(9)),
    end: Date.parse(at(11)),
  });
  assert.deepEqual(clipInterval(interval, { start: at(10), end: at(12) }), {
    start: Date.parse(at(10)),
    end: Date.parse(at(11)),
  });
  assert.equal(
    clipInterval(interval, { start: at(11), end: at(12) }),
    null,
    "touching edge is empty",
  );
  assert.equal(clipInterval(interval, { start: at(12), end: at(13) }), null, "disjoint is empty");
  assert.equal(clipInterval({ start: at(9), end: at(9) }, WINDOW), null, "zero-length is empty");
  assert.equal(clipInterval({ start: at(11), end: at(9) }, WINDOW), null, "reversed is empty");
  assert.equal(clipInterval({ start: "junk", end: at(9) }, WINDOW), null);
  assert.equal(clipInterval(null, WINDOW), null);

  // A missing window bound is unbounded rather than an error — `collect --from` can be open-ended.
  assert.deepEqual(clipInterval(interval, null), {
    start: Date.parse(at(9)),
    end: Date.parse(at(11)),
  });
  assert.deepEqual(clipInterval(interval, { start: at(10) }), {
    start: Date.parse(at(10)),
    end: Date.parse(at(11)),
  });
});

test("mergeIntervals unions overlapping and exactly-adjacent intervals", () => {
  const merged = mergeIntervals(
    shuffled([
      { start: at(9), end: at(10) },
      { start: at(10), end: at(11) }, // adjacent — one continuous stretch, not two
      { start: at(9, 30), end: at(9, 45) }, // fully nested
      { start: at(13), end: at(14) },
      { start: at(13, 30), end: at(15) }, // overlapping
      { start: at(20), end: at(19) }, // reversed, dropped
      { start: "junk", end: at(21) }, // unparseable, dropped
    ]),
  );

  assert.deepEqual(
    merged.map((interval) => [interval.start, interval.end, interval.ms]),
    [
      [Date.parse(at(9)), Date.parse(at(11)), 2 * HOUR],
      [Date.parse(at(13)), Date.parse(at(15)), 2 * HOUR],
    ],
  );
});

test("sumIntervals counts overlaps twice; mergeIntervals does not", () => {
  const intervals = [
    { start: at(9), end: at(10) },
    { start: at(9), end: at(10) },
    { start: at(9, 30), end: at(10, 30) },
  ];

  assert.equal(sumIntervals(intervals), 3 * HOUR);
  assert.equal(sumIntervals(mergeIntervals(intervals)), 1.5 * HOUR);
  assert.equal(
    sumIntervals([{ start: at(10), end: at(9) }]),
    0,
    "negative spans contribute nothing",
  );
});

test("buildBlocks splits only on a gap GREATER than the threshold", () => {
  const start = Date.parse(at(9));

  const held = buildBlocks([start, start + GAP], { gapMs: GAP, singleEventMs: SINGLE });
  assert.equal(held.length, 1, "a gap of exactly 30m stays in one block");
  assert.equal(held[0].ms, GAP);

  const broken = buildBlocks([start, start + GAP + 1], { gapMs: GAP, singleEventMs: SINGLE });
  assert.equal(broken.length, 2, "30m plus one millisecond splits");
  assert.deepEqual(
    broken.map((block) => block.ms),
    [SINGLE, SINGLE],
  );
});

test("buildBlocks sorts its input, ignores junk and gives duration-less blocks the single-event value", () => {
  const blocks = buildBlocks(
    shuffled([
      at(9, 40),
      at(9),
      "not a date",
      at(9, 20),
      null,
      at(13),
      undefined,
      at(13),
      {},
      NaN,
      at(9, 20),
    ]),
    { gapMs: GAP, singleEventMs: SINGLE },
  );

  assert.deepEqual(
    blocks.map((block) => [block.start, block.end, block.ms]),
    [
      [Date.parse(at(9)), Date.parse(at(9, 40)), 40 * MINUTE],
      // Two events at the same instant span no time but are still real activity.
      [Date.parse(at(13)), Date.parse(at(13)), SINGLE],
    ],
  );
  assert.equal(activeMs(blocks), 40 * MINUTE + SINGLE);
});

test("two parallel sessions produce the wall-clock union, not the sum of their spans", () => {
  // Interleaved, as two agents working at once actually look in the merged event stream.
  const sessionA = [at(9, 0), at(9, 10), at(9, 20), at(9, 30), at(9, 40)];
  const sessionB = [at(9, 15), at(9, 25), at(9, 35), at(9, 50), at(10, 0)];

  const timeline = activeTimeline([...sessionA, ...sessionB], {
    gapMs: GAP,
    singleEventMs: SINGLE,
    window: WINDOW,
  });

  const spanA = { start: sessionA[0], end: sessionA.at(-1) };
  const spanB = { start: sessionB[0], end: sessionB.at(-1) };
  const union = sumIntervals(mergeIntervals([spanA, spanB]));
  const naiveSum = sumIntervals([spanA, spanB]);

  assert.equal(union, 60 * MINUTE);
  assert.equal(naiveSum, 85 * MINUTE);
  assert.equal(timeline.activeMs, union, "active time is the union of the two sessions");
  assert.notEqual(timeline.activeMs, naiveSum, "active time must never be the sum");
  assert.equal(timeline.blocks.length, 1);
  assert.deepEqual(timeline.blocks[0], {
    start: new Date(Date.parse(at(9))).toISOString(),
    end: new Date(Date.parse(at(10))).toISOString(),
    ms: 60 * MINUTE,
  });
});

test("activeTimeline emits ISO bounds and clips blocks to the window", () => {
  const timeline = activeTimeline([at(-2), at(-1), at(0), at(1)], {
    gapMs: 2 * HOUR,
    singleEventMs: SINGLE,
    window: WINDOW,
  });

  assert.equal(timeline.blocks.length, 1);
  assert.equal(
    timeline.blocks[0].start,
    new Date(DAY_START).toISOString(),
    "clipped to local midnight",
  );
  assert.equal(timeline.blocks[0].end, new Date(Date.parse(at(1))).toISOString());
  assert.equal(timeline.activeMs, HOUR);
  assert.equal(typeof timeline.blocks[0].start, "string");
});

test("a single-event block survives only while the event is inside the half-open window", () => {
  const options = { gapMs: GAP, singleEventMs: SINGLE, window: WINDOW };

  const onStart = activeTimeline([DAY_START], options);
  assert.equal(onStart.blocks.length, 1);
  assert.equal(onStart.activeMs, SINGLE, "midnight opens the day");

  const onEnd = activeTimeline([DAY_END], options);
  assert.deepEqual(onEnd.blocks, [], "the next midnight belongs to the next day");
  assert.equal(onEnd.activeMs, 0);

  const outside = activeTimeline([at(9)], { ...options, window: { start: at(12), end: at(13) } });
  assert.deepEqual(outside.blocks, []);
  assert.equal(outside.activeMs, 0);
});

test("a day's active time can never exceed the window, however pathological the input", () => {
  // Dense events spilling two hours past both edges, duplicated, unsorted and salted with junk.
  const stamps = [];
  for (let stamp = DAY_START - 2 * HOUR; stamp <= DAY_END + 2 * HOUR; stamp += 5 * MINUTE) {
    stamps.push(new Date(stamp).toISOString());
  }
  // Five sessions running in parallel all day, each offset by a minute.
  for (let session = 0; session < 5; session += 1) {
    for (let stamp = DAY_START; stamp < DAY_END; stamp += 10 * MINUTE) {
      stamps.push(new Date(stamp + session * MINUTE).toISOString());
    }
  }
  stamps.push("not a date", "", null, undefined, {}, NaN, new Date(DAY_START).toISOString());

  const spilling = activeTimeline(shuffled(stamps), {
    gapMs: GAP,
    singleEventMs: SINGLE,
    window: WINDOW,
  });
  assert.ok(spilling.activeMs <= DAY_MS, `${spilling.activeMs} exceeded the ${DAY_MS}ms day`);
  assert.equal(spilling.activeMs, DAY_MS, "a fully covered day is exactly the day, never more");

  // The one genuine overflow vector: a single-event value larger than the window itself.
  const absurd = activeTimeline([at(1)], {
    gapMs: GAP,
    singleEventMs: 10 * 24 * HOUR,
    window: WINDOW,
  });
  assert.ok(absurd.activeMs <= DAY_MS);
  assert.equal(absurd.activeMs, DAY_MS);

  // And the same guarantee for a narrow window.
  const narrow = { start: at(9), end: at(9, 30) };
  const pinched = activeTimeline(shuffled(stamps), {
    gapMs: GAP,
    singleEventMs: SINGLE,
    window: narrow,
  });
  assert.ok(pinched.activeMs <= 30 * MINUTE);
});

test("agent runtime sums parallel sessions and legitimately exceeds the day", () => {
  const spans = [0, 1, 2].map((index) => ({
    start: new Date(DAY_START + index * 1000).toISOString(),
    end: new Date(DAY_END).toISOString(),
  }));

  const runtime = agentRuntimeMs(spans, WINDOW, { now: DAY_END });
  assert.equal(runtime, 3 * DAY_MS - (0 + 1000 + 2000));
  assert.ok(
    runtime > DAY_MS,
    "three sessions running all day is more than one day of machine time",
  );

  const active = activeTimeline(
    [...spans.map((span) => span.start), ...spans.map((span) => span.end)],
    {
      gapMs: GAP,
      singleEventMs: SINGLE,
      window: WINDOW,
    },
  );
  assert.ok(runtime > active.activeMs, "agent runtime always dominates active time here");
});

test("agentRuntimeMs closes a running span at min(window end, now) and drops impossible spans", () => {
  const running = [{ start: at(9), end: null }];

  assert.equal(
    agentRuntimeMs(running, WINDOW, { now: DAY_END + 5 * HOUR }),
    DAY_END - Date.parse(at(9)),
    "a turn still running past midnight is clipped to the window",
  );
  assert.equal(
    agentRuntimeMs(running, WINDOW, { now: at(11) }),
    2 * HOUR,
    "otherwise clipped to now",
  );
  assert.equal(
    agentRuntimeMs([{ start: at(9) }], WINDOW, { now: at(10) }),
    HOUR,
    "absent end reads as running",
  );
  assert.equal(
    agentRuntimeMs(running, null, { now: at(10) }),
    HOUR,
    "an unbounded window still closes at now",
  );

  // The turn rows this consumes are `started_at` / `completed_at`.
  assert.equal(agentRuntimeMs([{ startedAt: at(9), completedAt: at(10) }], WINDOW), HOUR);
  assert.equal(
    agentRuntimeMs([{ startedAt: at(9), completedAt: null }], WINDOW, { now: at(10) }),
    HOUR,
  );

  assert.equal(
    agentRuntimeMs([{ start: at(11), end: at(9) }], WINDOW),
    0,
    "negative durations are dropped",
  );
  assert.equal(agentRuntimeMs([{ start: "junk", end: at(9) }], WINDOW), 0);
  assert.equal(agentRuntimeMs([{ start: at(9), end: "junk" }], WINDOW), 0);
  assert.equal(agentRuntimeMs([{ start: at(9), end: at(10) }], { start: at(12), end: at(13) }), 0);
  assert.equal(agentRuntimeMs([null, undefined, 7, "x"], WINDOW), 0);
});

test("a turn spanning midnight is split across both days and the halves sum to the whole", () => {
  const turn = {
    key: "t3-abc123",
    start: new Date(2026, 7, 10, 23, 30).toISOString(),
    end: new Date(2026, 7, 11, 0, 45).toISOString(),
  };
  const whole = toMs(turn.end) - toMs(turn.start);

  const byDay = splitByDay([turn], ["2026-08-10", "2026-08-11", "2026-08-12"]);

  assert.deepEqual([...byDay.keys()], ["2026-08-10", "2026-08-11", "2026-08-12"]);
  assert.equal(byDay.get("2026-08-10").length, 1);
  assert.equal(byDay.get("2026-08-10")[0].ms, 30 * MINUTE);
  assert.equal(byDay.get("2026-08-11")[0].ms, 45 * MINUTE);
  assert.deepEqual(
    byDay.get("2026-08-12"),
    [],
    "a requested day with no work is present and empty",
  );

  const halves = byDay.get("2026-08-10")[0].ms + byDay.get("2026-08-11")[0].ms;
  assert.equal(halves, whole);
  assert.equal(halves, 75 * MINUTE);

  // The pieces stay attributable, and the seam is exactly local midnight.
  assert.equal(byDay.get("2026-08-10")[0].key, "t3-abc123");
  assert.equal(byDay.get("2026-08-10")[0].end, new Date(2026, 7, 11).getTime());
  assert.equal(byDay.get("2026-08-11")[0].start, new Date(2026, 7, 11).getTime());
});

test("splitByDay covers multi-day intervals, derives its own keys, and drops what was not asked for", () => {
  const long = {
    start: new Date(2026, 7, 9, 12).toISOString(),
    end: new Date(2026, 7, 12, 6).toISOString(),
  };

  const derived = splitByDay([long]);
  assert.deepEqual([...derived.keys()], ["2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]);
  assert.equal(
    derived.get("2026-08-10")[0].ms,
    DAY_MS,
    "a fully covered middle day is the whole day",
  );
  const total = [...derived.values()].reduce((sum, pieces) => sum + sumIntervals(pieces), 0);
  assert.equal(
    total,
    toMs(long.end) - toMs(long.start),
    "the pieces reconstruct the original span",
  );

  const narrowed = splitByDay([long], [DAY_KEY]);
  assert.deepEqual([...narrowed.keys()], [DAY_KEY]);
  assert.equal(narrowed.get(DAY_KEY)[0].ms, DAY_MS);

  // An interval ending exactly at midnight spends no time in the following day.
  const upToMidnight = splitByDay([{ start: at(23), end: new Date(2026, 7, 11).toISOString() }]);
  assert.deepEqual([...upToMidnight.keys()], [DAY_KEY]);

  // A zero-width block (a lone event) keeps its declared duration instead of vanishing.
  const point = splitByDay([{ start: at(9), end: at(9), ms: SINGLE }], [DAY_KEY]);
  assert.equal(point.get(DAY_KEY)[0].ms, SINGLE);

  assert.deepEqual(
    [...splitByDay([long], ["2026-13-99", "nonsense"]).keys()],
    [],
    "invalid day keys are skipped",
  );
  assert.deepEqual([...splitByDay([{ start: "junk", end: at(9) }], [DAY_KEY]).get(DAY_KEY)], []);
});

test(
  "splitByDay uses real local day lengths across a DST change",
  { skip: TZ_PINNED ? false : "TZ not applied" },
  () => {
    // 2026-11-01 falls back in America/Toronto: a 25-hour local day.
    const longDayMs = new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime();
    const shortDayMs = new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime();
    assert.equal(longDayMs, 25 * HOUR);
    assert.equal(shortDayMs, 23 * HOUR);

    const span = {
      start: new Date(2026, 9, 31, 12).toISOString(),
      end: new Date(2026, 10, 2, 12).toISOString(),
    };
    const byDay = splitByDay([span]);

    assert.deepEqual([...byDay.keys()], ["2026-10-31", "2026-11-01", "2026-11-02"]);
    assert.equal(byDay.get("2026-11-01")[0].ms, longDayMs, "the fall-back day really is 25 hours");
    const total = [...byDay.values()].reduce((sum, pieces) => sum + sumIntervals(pieces), 0);
    assert.equal(total, toMs(span.end) - toMs(span.start));

    // Active time on a 25-hour day is bounded by 25 hours, not by a hardcoded 24.
    const stamps = [];
    for (
      let stamp = new Date(2026, 10, 1).getTime();
      stamp <= new Date(2026, 10, 2).getTime();
      stamp += 5 * MINUTE
    ) {
      stamps.push(new Date(stamp).toISOString());
    }
    const timeline = activeTimeline(stamps, {
      gapMs: GAP,
      singleEventMs: SINGLE,
      window: { start: new Date(2026, 10, 1).getTime(), end: new Date(2026, 10, 2).getTime() },
    });
    assert.equal(timeline.activeMs, longDayMs);
  },
);

test("empty and absent input yields zeroes, never NaN", () => {
  const numbers = [
    sumIntervals([]),
    sumIntervals(undefined),
    sumIntervals(null),
    activeMs([]),
    activeMs(undefined),
    activeMs([{}, { ms: "x" }, null]),
    activeTimeline([], { gapMs: GAP, singleEventMs: SINGLE, window: WINDOW }).activeMs,
    activeTimeline(undefined).activeMs,
    activeTimeline(["junk", null]).activeMs,
    agentRuntimeMs([], WINDOW),
    agentRuntimeMs(undefined, undefined),
    agentRuntimeMs(null, WINDOW, { now: DAY_START }),
  ];
  for (const value of numbers) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value), `expected a finite number, got ${value}`);
    assert.equal(value, 0);
  }

  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals(undefined), []);
  assert.deepEqual(mergeIntervals("not intervals"), []);
  assert.deepEqual(buildBlocks([], { gapMs: GAP, singleEventMs: SINGLE }), []);
  assert.deepEqual(buildBlocks(undefined), []);
  assert.deepEqual(activeTimeline([], { window: WINDOW }).blocks, []);
  assert.deepEqual([...splitByDay([]).keys()], []);
  assert.deepEqual([...splitByDay([], [DAY_KEY]).get(DAY_KEY)], []);
  assert.deepEqual([...splitByDay(undefined, undefined).keys()], []);
});

test("missing options fall back to the documented defaults rather than producing NaN", () => {
  const start = Date.parse(at(9));

  const defaults = buildBlocks([start, start + 30 * MINUTE, start + 90 * MINUTE]);
  assert.equal(defaults.length, 2, "default gap is 30 minutes");
  assert.deepEqual(
    defaults.map((block) => block.ms),
    [30 * MINUTE, 1 * MINUTE],
    "default single-event value is 1 minute",
  );

  const garbage = buildBlocks([start, start + 40 * MINUTE], { gapMs: "thirty", singleEventMs: -5 });
  assert.equal(garbage.length, 2);
  assert.deepEqual(
    garbage.map((block) => block.ms),
    [1 * MINUTE, 1 * MINUTE],
  );
});
