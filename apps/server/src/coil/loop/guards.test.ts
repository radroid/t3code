// @effect-diagnostics globalDate:off -- `iso` is a pure ms->ISO fixture helper anchored on a
// fixed constant, never a wall-clock reading, so DateTime's effectful now-semantics would add
// ceremony without adding correctness.
/**
 * TESTS.md §2, cases 30–46: the guard table's ordering and the *kind* of block each guard
 * produces. Case numbers are cited in the test names so a number quoted anywhere in the
 * design still names the same test. Retired guards (5, 13) keep their numbers reserved.
 */

import { describe, expect, it } from "vite-plus/test";

import { resolveConfig } from "./config.ts";
import {
  atArmedCeiling,
  blockingRequest,
  checkInFloorMet,
  doneSignal,
  evaluateGuards,
  hasPendingCrons,
  idleThresholdMet,
  isArchived,
  isArmed,
  isoMs,
  isRateLimited,
  isSnoozed,
  isStopped,
  masterToggleOff,
  needsPinRepair,
  stopCondition,
  STRIKE_LIMIT,
  tookOver,
  wakeIsLost,
  wakeIsPending,
} from "./guards.ts";
import { DEFAULT_GLOBAL_SETTINGS, EMPTY_RECORD, type LoopRecord } from "./state.ts";
import type { LoopGuardInput, LoopThreadShell, ResolvedWake, TriggerFacts } from "./types.ts";

const config = resolveConfig({}); // idle 15m, busy 45m, productive 2m, grace 90s..15m @10%
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

const globalSettings = (o: Partial<typeof DEFAULT_GLOBAL_SETTINGS> = {}) => ({
  ...DEFAULT_GLOBAL_SETTINGS,
  enabled: true,
  ...o,
});

/** An armed, healthy, mid-run record. Overrides are the point of each case. */
const record = (o: Partial<LoopRecord> = {}): LoopRecord =>
  Object.freeze({
    ...EMPTY_RECORD,
    armed: true,
    armedAtMs: NOW - 2 * HOUR,
    maxCheckIns: 6,
    checkInsUsed: 1,
    deadlineAtMs: NOW + 4 * HOUR,
    ...o,
  });

type ShellOverrides = {
  updatedAt?: string;
  archivedAt?: string | null;
  settledOverride?: "settled" | "active" | null;
  snoozedUntil?: string | null;
  sessionStatus?: string | null;
  providerName?: string | null;
  latestUserMessageAt?: string | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasActionableProposedPlan?: boolean;
};

const shell = (o: ShellOverrides = {}): LoopThreadShell =>
  ({
    updatedAt: o.updatedAt ?? iso(NOW - 20 * MINUTE),
    archivedAt: o.archivedAt ?? null,
    settledOverride: o.settledOverride ?? null,
    snoozedUntil: o.snoozedUntil ?? null,
    session:
      o.sessionStatus === null
        ? null
        : {
            threadId: "thread-1",
            status: o.sessionStatus ?? "ready",
            providerName: o.providerName === undefined ? "claudeAgent" : o.providerName,
            runtimeMode: "local",
            activeTurnId: null,
            lastError: null,
            updatedAt: iso(NOW - 20 * MINUTE),
          },
    latestTurn: null,
    latestUserMessageAt: o.latestUserMessageAt ?? null,
    hasPendingApprovals: o.hasPendingApprovals ?? false,
    hasPendingUserInput: o.hasPendingUserInput ?? false,
    hasActionableProposedPlan: o.hasActionableProposedPlan ?? false,
  }) as unknown as LoopThreadShell;

/** Defaults to "the thread is stale enough to nudge", so each case perturbs one thing. */
const trigger = (o: Partial<TriggerFacts> = {}): TriggerFacts => ({
  idleForMs: 20 * MINUTE,
  thresholdMs: 15 * MINUTE,
  busyTurn: false,
  wake: null,
  ...o,
});

const wake = (o: Partial<ResolvedWake> = {}): ResolvedWake => ({
  cronId: "cron-1",
  atMs: NOW + 10 * MINUTE,
  graceMs: 90_000,
  deferrable: true,
  landed: false,
  ...o,
});

const guardInput = (o: Partial<LoopGuardInput> = {}): LoopGuardInput => ({
  nowMs: NOW,
  processStartedAtMs: NOW - 24 * HOUR,
  record: record(),
  global: globalSettings(),
  shell: shell(),
  sentinelAtMs: null,
  loopDoneAtMs: null,
  autoResumePending: false,
  armedCount: 1,
  config,
  trigger: trigger(),
  ...o,
});

describe("evaluateGuards — the blocking guards", () => {
  it("30. the master toggle stands the loop down without disarming or stopping it", () => {
    const rec = record();
    const outcome = evaluateGuards(
      guardInput({ record: rec, global: globalSettings({ enabled: false }) }),
    );
    expect(outcome).toEqual({
      kind: "stand_down",
      guard: "2",
      reason: "disabled",
      phase: "standing_down",
      untilMs: null,
    });
    expect(rec.armed).toBe(true);
    expect(rec.stopped).toBeNull();
    expect(rec.checkInsUsed).toBe(1);
  });

  it("31. an unarmed record stands down, and a stopped one says so instead", () => {
    expect(evaluateGuards(guardInput({ record: record({ armed: false }) }))).toMatchObject({
      kind: "stand_down",
      guard: "3",
      reason: "not_armed",
      phase: "off",
    });
    // Terminal states are sticky and report themselves, even on a record still flagged armed.
    expect(
      evaluateGuards(
        guardInput({
          record: record({ stopped: { reason: "done", atMs: NOW - HOUR, detail: "" } }),
        }),
      ),
    ).toMatchObject({ kind: "stand_down", guard: "3", reason: "stopped" });
  });

  it("32. a thread that is gone disarms rather than skipping", () => {
    expect(evaluateGuards(guardInput({ shell: null }))).toEqual({
      kind: "disarm",
      guard: "4",
      reason: "thread_gone",
    });
  });

  it("33. an archived thread disarms", () => {
    expect(evaluateGuards(guardInput({ shell: shell({ archivedAt: iso(NOW - HOUR) }) }))).toEqual({
      kind: "disarm",
      guard: "4",
      reason: "archived",
    });
  });

  // Guard 5 is retired. `settledOverride` no longer distinguishes a human from a timer:
  // ThreadSettlementReactor sweeps every minute and emits the same event with no provenance.
  it("34. settledness never blocks a check-in (guard 5 is retired)", () => {
    expect(evaluateGuards(guardInput({ shell: shell({ settledOverride: "settled" }) }))).toEqual({
      kind: "fire",
      repairPin: false,
      degrade: null,
    });
  });

  it("34b. a loop auto-settled mid-run still checks in", () => {
    // The failure the retirement prevents: with the old guard this sat armed doing nothing
    // until its deadline and then reported `spent` — a skip never stops, so it failed silent.
    const settledByTimer = shell({ settledOverride: "settled", updatedAt: iso(NOW - 3 * HOUR) });
    const outcome = evaluateGuards(
      guardInput({ shell: settledByTimer, trigger: trigger({ idleForMs: 3 * HOUR }) }),
    );
    expect(outcome.kind).toBe("fire");
  });

  it("35. a live snooze stands the loop down and reports when it lifts", () => {
    const until = NOW + 30 * MINUTE;
    expect(evaluateGuards(guardInput({ shell: shell({ snoozedUntil: iso(until) }) }))).toEqual({
      kind: "stand_down",
      guard: "6",
      reason: "snoozed",
      phase: "watching",
      untilMs: until,
    });
  });

  it("36. an expired, absent or unreadable snooze passes", () => {
    expect(
      evaluateGuards(guardInput({ shell: shell({ snoozedUntil: iso(NOW - MINUTE) }) })).kind,
    ).toBe("fire");
    expect(evaluateGuards(guardInput({ shell: shell({ snoozedUntil: null }) })).kind).toBe("fire");
    expect(evaluateGuards(guardInput({ shell: shell({ snoozedUntil: "not-a-date" }) })).kind).toBe(
      "fire",
    );
  });

  it("37. a pending approval blocks", () => {
    expect(evaluateGuards(guardInput({ shell: shell({ hasPendingApprovals: true }) }))).toEqual({
      kind: "stand_down",
      guard: "8",
      reason: "pending_approval",
      phase: "blocked",
      untilMs: null,
    });
  });

  it("38. a pending user-input request blocks", () => {
    expect(
      evaluateGuards(guardInput({ shell: shell({ hasPendingUserInput: true }) })),
    ).toMatchObject({ guard: "8", reason: "pending_user_input" });
  });

  // The clause every design in the original panel missed: Sidebar.logic.ts treats
  // plan-ready as NOT pending-input, so a thread parked on an unapproved plan otherwise
  // passes every blocking guard and gets pushed past the human's yes.
  it("39. an actionable proposed plan blocks", () => {
    expect(
      evaluateGuards(guardInput({ shell: shell({ hasActionableProposedPlan: true }) })),
    ).toMatchObject({ guard: "8", reason: "pending_plan" });
  });

  it("40. none of the three blocking facts set: the guard passes", () => {
    expect(blockingRequest(shell())).toBeNull();
    expect(evaluateGuards(guardInput()).kind).toBe("fire");
  });

  it("41. an armed auto-resume owns the thread; the loop stands down", () => {
    expect(evaluateGuards(guardInput({ autoResumePending: true }))).toEqual({
      kind: "stand_down",
      guard: "9",
      reason: "auto_resume_pending",
      phase: "watching",
      untilMs: null,
    });
  });

  it("42. a usage limit holds the loop, and the boundary is inclusive", () => {
    expect(
      evaluateGuards(guardInput({ record: record({ rateLimitedUntilMs: NOW + 5 * MINUTE }) })),
    ).toEqual({
      kind: "stand_down",
      guard: "10",
      reason: "rate_limited",
      phase: "held",
      untilMs: NOW + 5 * MINUTE,
    });
    // `now >= rateLimitedUntilMs` passes: the hold is over at exactly its own deadline.
    expect(evaluateGuards(guardInput({ record: record({ rateLimitedUntilMs: NOW }) })).kind).toBe(
      "fire",
    );
  });

  it("10b. a pending wake inside the deadline stands the loop down as self-pacing", () => {
    const outcome = evaluateGuards(guardInput({ trigger: trigger({ wake: wake() }) }));
    expect(outcome).toEqual({
      kind: "stand_down",
      guard: "10b",
      reason: "self_pacing",
      phase: "self_pacing",
      untilMs: NOW + 10 * MINUTE,
    });
  });

  it("10b. a wake past its grace fires and flags the run degraded", () => {
    const lost = wake({ atMs: NOW - 10 * MINUTE, graceMs: 90_000 });
    expect(evaluateGuards(guardInput({ trigger: trigger({ wake: lost }) }))).toEqual({
      kind: "fire",
      repairPin: false,
      degrade: "wake_lost",
    });
  });

  it("43. the check-in floor holds even when the idle threshold appears met", () => {
    const rec = record({ lastCheckIn: { firedAtMs: NOW - 5 * MINUTE, createdAtIso: iso(NOW) } });
    expect(evaluateGuards(guardInput({ record: rec }))).toEqual({
      kind: "stand_down",
      guard: "11",
      reason: "check_in_floor",
      phase: "watching",
      untilMs: NOW - 5 * MINUTE + config.idleMs,
    });
    // Exactly at the floor it passes — the same inclusive boundary as every other threshold.
    const atFloor = record({
      lastCheckIn: { firedAtMs: NOW - config.idleMs, createdAtIso: iso(NOW - config.idleMs) },
    });
    expect(evaluateGuards(guardInput({ record: atFloor })).kind).toBe("fire");
  });

  it("12. below the staleness threshold the loop keeps watching", () => {
    expect(evaluateGuards(guardInput({ trigger: trigger({ idleForMs: MINUTE }) }))).toEqual({
      kind: "stand_down",
      guard: "12",
      reason: "not_idle",
      phase: "watching",
      untilMs: null,
    });
  });

  it("44. the machine-wide ceiling is re-checked per tick", () => {
    expect(evaluateGuards(guardInput({ armedCount: 3 }))).toEqual({
      kind: "stand_down",
      guard: "14",
      reason: "ceiling",
      phase: "standing_down",
      untilMs: null,
    });
    expect(evaluateGuards(guardInput({ armedCount: 2 })).kind).toBe("fire");
  });

  it("7. the keep-active pin rides out on the fire so the reactor can repair it", () => {
    expect(evaluateGuards(guardInput({ shell: shell({ settledOverride: "active" }) }))).toEqual({
      kind: "fire",
      repairPin: true,
      degrade: null,
    });
  });
});

describe("evaluateGuards — ordering", () => {
  it("45. a record tripping several guards reports the first, because that string is rendered", () => {
    const outcome = evaluateGuards(
      guardInput({
        global: globalSettings({ enabled: false }),
        record: record({ armed: false, rateLimitedUntilMs: NOW + HOUR }),
        shell: shell({ archivedAt: iso(NOW), hasPendingApprovals: true }),
        autoResumePending: true,
        armedCount: 99,
      }),
    );
    expect(outcome).toMatchObject({ guard: "2", reason: "disabled" });
  });

  it("45b. guard 4b is swept before every skip: past-deadline-and-held reports the stop", () => {
    // "The loop is held" and "the loop is over" are different words on the console, and the
    // wrong one hides a finished run behind a hold.
    const outcome = evaluateGuards(
      guardInput({
        record: record({ deadlineAtMs: NOW - MINUTE, rateLimitedUntilMs: NOW + HOUR }),
      }),
    );
    expect(outcome).toMatchObject({
      kind: "stop",
      guard: "4b",
      outcome: "spent",
      cause: "deadline",
    });
  });

  it("45c. guard 4b runs after guard 4: a deleted thread disarms, it does not report spent", () => {
    expect(
      evaluateGuards(guardInput({ shell: null, record: record({ deadlineAtMs: NOW - MINUTE }) })),
    ).toEqual({ kind: "disarm", guard: "4", reason: "thread_gone" });
  });

  it("45d. guard 2 precedes 4b: the toggle stands loops down, it never manufactures a stop", () => {
    expect(
      evaluateGuards(
        guardInput({
          global: globalSettings({ enabled: false }),
          record: record({ deadlineAtMs: NOW - MINUTE }),
        }),
      ),
    ).toMatchObject({ kind: "stand_down", guard: "2", reason: "disabled" });
  });

  // A future guard added without the non-consuming property fails here rather than in
  // production at 3am.
  it("46. no stand-down touches the budget, across every skipping guard", () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly input: LoopGuardInput }> = [
      { name: "2 disabled", input: guardInput({ global: globalSettings({ enabled: false }) }) },
      { name: "3 not armed", input: guardInput({ record: record({ armed: false }) }) },
      {
        name: "3 stopped",
        input: guardInput({
          record: record({ stopped: { reason: "spent", atMs: NOW, detail: "" } }),
        }),
      },
      {
        name: "6 snoozed",
        input: guardInput({ shell: shell({ snoozedUntil: iso(NOW + HOUR) }) }),
      },
      {
        name: "8 approval",
        input: guardInput({ shell: shell({ hasPendingApprovals: true }) }),
      },
      {
        name: "8 user input",
        input: guardInput({ shell: shell({ hasPendingUserInput: true }) }),
      },
      {
        name: "8 plan",
        input: guardInput({ shell: shell({ hasActionableProposedPlan: true }) }),
      },
      { name: "9 auto-resume", input: guardInput({ autoResumePending: true }) },
      {
        name: "10 rate limited",
        input: guardInput({ record: record({ rateLimitedUntilMs: NOW + HOUR }) }),
      },
      { name: "10b self-pacing", input: guardInput({ trigger: trigger({ wake: wake() }) }) },
      {
        name: "11 check-in floor",
        input: guardInput({
          record: record({ lastCheckIn: { firedAtMs: NOW - MINUTE, createdAtIso: iso(NOW) } }),
        }),
      },
      { name: "12 not idle", input: guardInput({ trigger: trigger({ idleForMs: 0 }) }) },
      { name: "14 ceiling", input: guardInput({ armedCount: 5 }) },
    ];

    for (const { name, input } of cases) {
      const before = { used: input.record.checkInsUsed, strikes: input.record.strikes };
      const outcome = evaluateGuards(input);
      expect(outcome.kind, name).toBe("stand_down");
      // The record is frozen, so a mutating guard would have thrown above; this asserts the
      // decision itself carries no budget change either.
      expect({ used: input.record.checkInsUsed, strikes: input.record.strikes }, name).toEqual(
        before,
      );
    }
    // Every reason in the union is exercised except the ones only `decide` can reach.
    expect(cases).toHaveLength(13);
  });
});

describe("stopCondition — the 4b sweep", () => {
  const sweep = (o: Partial<LoopGuardInput> = {}) => {
    const input = guardInput(o);
    return stopCondition({ ...input, shell: input.shell ?? shell() });
  };

  it("reports nothing on a healthy mid-run record", () => {
    expect(sweep()).toBeNull();
  });

  it("14/17. a passed deadline is `spent`, never `done`, even with budget left", () => {
    const stop = sweep({ record: record({ deadlineAtMs: NOW - 1, checkInsUsed: 0 }) });
    expect(stop?.outcome).toBe("spent");
    expect(stop?.cause).toBe("deadline");
  });

  it("13. an exhausted budget is `spent`", () => {
    expect(sweep({ record: record({ checkInsUsed: 6, maxCheckIns: 6 }) })).toMatchObject({
      outcome: "spent",
      cause: "budget",
    });
  });

  it("a fresh done-file stops the run as done; a stale one is a leftover", () => {
    expect(sweep({ sentinelAtMs: NOW - MINUTE })).toMatchObject({
      outcome: "done",
      cause: "sentinel",
    });
    // Older than armedAtMs: a file from a previous run is not this run's signal.
    expect(sweep({ sentinelAtMs: NOW - 3 * HOUR })).toBeNull();
  });

  it("the loop_done call is equivalent to the file, and the newer of the two wins", () => {
    expect(sweep({ loopDoneAtMs: NOW - MINUTE })).toMatchObject({ cause: "loop_done" });
    expect(sweep({ sentinelAtMs: NOW - MINUTE, loopDoneAtMs: NOW - 2 * MINUTE })).toMatchObject({
      cause: "sentinel",
    });
    expect(sweep({ sentinelAtMs: NOW - 2 * MINUTE, loopDoneAtMs: NOW - MINUTE })).toMatchObject({
      cause: "loop_done",
    });
  });

  it("two strikes on the durable record stop the run as stalled", () => {
    expect(sweep({ record: record({ strikes: STRIKE_LIMIT }) })).toMatchObject({
      outcome: "stalled",
      cause: "strikes",
    });
    expect(sweep({ record: record({ strikes: STRIKE_LIMIT - 1 }) })).toBeNull();
  });

  it("takeover is swept last, so a run already over reports why T3 ended it", () => {
    const takenOver = shell({ latestUserMessageAt: iso(NOW - MINUTE) });
    expect(sweep({ shell: takenOver })).toMatchObject({
      outcome: "handed-back",
      cause: "takeover",
    });
    expect(sweep({ shell: takenOver, record: record({ deadlineAtMs: NOW - 1 }) })).toMatchObject({
      outcome: "spent",
      cause: "deadline",
    });
  });
});

describe("guard predicates", () => {
  it("isoMs reads a timestamp, or reports that it could not", () => {
    expect(isoMs(iso(NOW))).toBe(NOW);
    expect(isoMs("nonsense")).toBeNull();
    expect(isoMs(null)).toBeNull();
    expect(isoMs(undefined)).toBeNull();
  });

  it("masterToggleOff, isStopped, isArmed and isArchived read one field each", () => {
    expect(masterToggleOff(globalSettings({ enabled: false }))).toBe(true);
    expect(masterToggleOff(globalSettings())).toBe(false);
    expect(isStopped(record())).toBe(false);
    expect(isStopped(record({ stopped: { reason: "done", atMs: NOW, detail: "" } }))).toBe(true);
    expect(isArmed(record())).toBe(true);
    expect(isArmed(record({ armed: false }))).toBe(false);
    expect(isArchived(shell())).toBe(false);
    expect(isArchived(shell({ archivedAt: iso(NOW) }))).toBe(true);
  });

  it("isSnoozed, needsPinRepair, isRateLimited and atArmedCeiling", () => {
    expect(isSnoozed(shell({ snoozedUntil: iso(NOW + 1) }), NOW)).toBe(true);
    expect(isSnoozed(shell({ snoozedUntil: iso(NOW) }), NOW)).toBe(false);
    expect(needsPinRepair(shell({ settledOverride: "active" }))).toBe(true);
    expect(needsPinRepair(shell({ settledOverride: "settled" }))).toBe(false);
    expect(isRateLimited(record({ rateLimitedUntilMs: NOW + 1 }), NOW)).toBe(true);
    expect(isRateLimited(record(), NOW)).toBe(false);
    expect(atArmedCeiling(3, globalSettings({ maxArmedThreads: 3 }))).toBe(true);
    expect(atArmedCeiling(2, globalSettings({ maxArmedThreads: 3 }))).toBe(false);
  });

  it("the wake predicates split pending from lost at an inclusive boundary", () => {
    const atMs = NOW - 10 * MINUTE;
    const graceMs = 5 * MINUTE;
    const pending = wake({ atMs, graceMs });
    expect(wakeIsPending(trigger({ wake: pending }), atMs + graceMs - 1)).toBe(true);
    expect(wakeIsPending(trigger({ wake: pending }), atMs + graceMs)).toBe(false);
    expect(wakeIsLost(trigger({ wake: pending }), atMs + graceMs)).toBe(true);
    expect(wakeIsLost(trigger({ wake: pending }), atMs + graceMs - 1)).toBe(false);
    // No wake, a wake past the deadline, and a wake that landed all mean "no deference".
    for (const candidate of [null, wake({ deferrable: false }), wake({ landed: true })]) {
      const facts = trigger({ wake: candidate });
      expect(wakeIsPending(facts, NOW)).toBe(false);
      expect(wakeIsLost(facts, NOW)).toBe(false);
    }
  });

  it("checkInFloorMet and idleThresholdMet are both inclusive", () => {
    expect(checkInFloorMet(record(), config, NOW)).toBe(true);
    const last = { firedAtMs: NOW - config.idleMs, createdAtIso: iso(NOW - config.idleMs) };
    expect(checkInFloorMet(record({ lastCheckIn: last }), config, NOW)).toBe(true);
    expect(checkInFloorMet(record({ lastCheckIn: last }), config, NOW - 1)).toBe(false);
    expect(idleThresholdMet(trigger({ idleForMs: 15 * MINUTE, thresholdMs: 15 * MINUTE }))).toBe(
      true,
    );
    expect(idleThresholdMet(trigger({ idleForMs: 15 * MINUTE - 1 }))).toBe(false);
  });

  it("tookOver compares the exact minted createdAt, then falls back to armedAtMs", () => {
    const last = { firedAtMs: NOW - HOUR, createdAtIso: iso(NOW - HOUR) };
    const rec = record({ lastCheckIn: last });
    expect(tookOver(rec, shell({ latestUserMessageAt: iso(NOW - MINUTE) }))).toBe(true);
    // Our own nudge: equal is not later. This is the off-by-one that would disarm every
    // loop on its own first check-in.
    expect(tookOver(rec, shell({ latestUserMessageAt: last.createdAtIso }))).toBe(false);
    expect(tookOver(rec, shell({ latestUserMessageAt: null }))).toBe(false);
    // 29. Armed but never fired: the baseline is armedAtMs.
    const fresh = record({ lastCheckIn: null, armedAtMs: NOW - HOUR });
    expect(tookOver(fresh, shell({ latestUserMessageAt: iso(NOW - MINUTE) }))).toBe(true);
    expect(tookOver(fresh, shell({ latestUserMessageAt: iso(NOW - 2 * HOUR) }))).toBe(false);
    expect(tookOver(fresh, shell({ latestUserMessageAt: "nonsense" }))).toBe(false);
  });

  it("doneSignal ignores anything older than the arm", () => {
    const rec = record({ armedAtMs: NOW - HOUR });
    expect(doneSignal({ record: rec, sentinelAtMs: null, loopDoneAtMs: null })).toBeNull();
    expect(
      doneSignal({ record: rec, sentinelAtMs: NOW - 2 * HOUR, loopDoneAtMs: NOW - 2 * HOUR }),
    ).toBeNull();
    expect(doneSignal({ record: rec, sentinelAtMs: NOW, loopDoneAtMs: null })).toEqual({
      cause: "sentinel",
      atMs: NOW,
    });
  });

  it("hasPendingCrons treats a recurring entry as pending whatever its next fire", () => {
    expect(hasPendingCrons(record(), NOW)).toBe(false);
    const entry = (o: Record<string, unknown>) => ({
      id: "c1",
      schedule: "*/30 * * * *",
      recurring: false,
      prompt: "",
      nextFireAtMs: null,
      ...o,
    });
    const withCrons = (entries: ReadonlyArray<ReturnType<typeof entry>>) =>
      record({ crons: { recordedAtMs: NOW - HOUR, entries } });
    expect(hasPendingCrons(withCrons([]), NOW)).toBe(false);
    expect(hasPendingCrons(withCrons([entry({})]), NOW)).toBe(false);
    expect(hasPendingCrons(withCrons([entry({ nextFireAtMs: NOW - 1 })]), NOW)).toBe(false);
    expect(hasPendingCrons(withCrons([entry({ nextFireAtMs: NOW + 1 })]), NOW)).toBe(true);
    expect(hasPendingCrons(withCrons([entry({ recurring: true })]), NOW)).toBe(true);
  });
});
