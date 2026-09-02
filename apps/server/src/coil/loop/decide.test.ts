// @effect-diagnostics globalDate:off -- `iso` is a pure ms->ISO fixture helper anchored on a
// fixed constant, never a wall-clock reading, so DateTime's effectful now-semantics would add
// ceremony without adding correctness.
/**
 * TESTS.md §1, cases 1–29 (including 11b–11l for deference and 15/15b/15c for the deadline
 * while busy): the decision table. Case numbers lead each test name so a number quoted in
 * the design still names the same test.
 *
 * Every fixture record is frozen, so a decision that mutated its input would throw rather
 * than quietly spend a budget.
 */

import { describe, expect, it } from "vite-plus/test";

import { resolveConfig, wakeGraceMs } from "./config.ts";
import { decide, judgeProgress, resolveTrigger, resolveWake } from "./decide.ts";
import { DEFAULT_GLOBAL_SETTINGS, EMPTY_RECORD, type CronEntry, type LoopRecord } from "./state.ts";
import type { LoopAction, LoopDecisionInput, LoopThreadShell } from "./types.ts";

const config = resolveConfig({}); // idle 15m, busy 45m, productive 2m, grace 90s..15m @10%
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

const globalSettings = { ...DEFAULT_GLOBAL_SETTINGS, enabled: true, maxArmedThreads: 3 };

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
  sessionStatus?: string | null;
  providerName?: string | null;
  latestTurnState?: string | null;
  backgroundLiveness?: "working" | "monitoring" | null;
  latestUserMessageAt?: string | null;
  settledOverride?: "settled" | "active" | null;
};

const shell = (o: ShellOverrides = {}): LoopThreadShell =>
  ({
    updatedAt: o.updatedAt ?? iso(NOW - 20 * MINUTE),
    archivedAt: null,
    settledOverride: o.settledOverride ?? null,
    snoozedUntil: null,
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
    latestTurn:
      typeof o.latestTurnState === "string"
        ? {
            turnId: "turn-1",
            state: o.latestTurnState,
            requestedAt: iso(NOW - HOUR),
            startedAt: iso(NOW - HOUR),
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
    latestUserMessageAt: o.latestUserMessageAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: o.backgroundLiveness ?? null,
  }) as unknown as LoopThreadShell;

const entry = (o: Partial<CronEntry> = {}): CronEntry => ({
  id: "cron-1",
  schedule: "*/30 * * * *",
  recurring: false,
  prompt: "keep going",
  nextFireAtMs: null,
  ...o,
});

const crons = (entries: ReadonlyArray<CronEntry>) => ({ recordedAtMs: NOW - HOUR, entries });

const input = (o: Partial<LoopDecisionInput> = {}): LoopDecisionInput => ({
  nowMs: NOW,
  processStartedAtMs: NOW - 24 * HOUR,
  record: record(),
  global: globalSettings,
  shell: shell(),
  sentinelAtMs: null,
  loopDoneAtMs: null,
  autoResumePending: false,
  armedCount: 1,
  config,
  ...o,
});

const act = (o: Partial<LoopDecisionInput> = {}): LoopAction => decide(input(o));

describe("decide — 1.1 trigger arithmetic", () => {
  it("1. idle below the threshold keeps watching", () => {
    expect(act({ shell: shell({ updatedAt: iso(NOW - 14 * MINUTE) }) })).toMatchObject({
      type: "stand_down",
      reason: "not_idle",
      phase: "watching",
    });
  });

  it("2. idle exactly at the threshold fires (the boundary is inclusive)", () => {
    expect(act({ shell: shell({ updatedAt: iso(NOW - 15 * MINUTE) }) })).toMatchObject({
      type: "fire",
      kind: "check_in",
    });
  });

  it("3. idle above the threshold fires", () => {
    expect(act({ shell: shell({ updatedAt: iso(NOW - HOUR) }) })).toMatchObject({ type: "fire" });
  });

  it("4. a busy turn uses busyIdleMs, not idleMs", () => {
    const busy = shell({ sessionStatus: "running", updatedAt: iso(NOW - 46 * MINUTE) });
    expect(resolveTrigger(input({ shell: busy })).thresholdMs).toBe(45 * MINUTE);
    expect(act({ shell: busy })).toMatchObject({ type: "fire" });
  });

  it("5. a busy turn idle between the two thresholds keeps watching (the long tool call)", () => {
    const busy = shell({ sessionStatus: "running", updatedAt: iso(NOW - 30 * MINUTE) });
    expect(act({ shell: busy })).toMatchObject({ type: "stand_down", reason: "not_idle" });
  });

  it("6. `starting` counts as busy", () => {
    expect(resolveTrigger(input({ shell: shell({ sessionStatus: "starting" }) })).busyTurn).toBe(
      true,
    );
  });

  it("7. a running latest turn counts as busy even when the session is null", () => {
    const facts = resolveTrigger(
      input({ shell: shell({ sessionStatus: null, latestTurnState: "running" }) }),
    );
    expect(facts.busyTurn).toBe(true);
    expect(facts.thresholdMs).toBe(45 * MINUTE);
  });

  // The single most important line in the design: gating on `running` deadlocks the exact
  // threads this feature is for, because a turn whose completion never arrives pins the
  // status with nothing automated to clear it.
  it("8. `running` alone never suppresses a fire — it only lengthens the fuse", () => {
    expect(
      act({ shell: shell({ sessionStatus: "running", updatedAt: iso(NOW - 3 * HOUR) }) }),
    ).toMatchObject({ type: "fire" });
  });

  it("8b. backgroundLiveness lengthens the fuse and is never a veto", () => {
    const live = shell({ backgroundLiveness: "working", updatedAt: iso(NOW - 30 * MINUTE) });
    expect(resolveTrigger(input({ shell: live })).thresholdMs).toBe(45 * MINUTE);
    expect(act({ shell: live })).toMatchObject({ type: "stand_down", reason: "not_idle" });
    // ...but past the longer threshold it still fires. An empty roster after a restart must
    // never read as "nothing is running".
    const stale = shell({ backgroundLiveness: "monitoring", updatedAt: iso(NOW - 3 * HOUR) });
    expect(act({ shell: stale })).toMatchObject({ type: "fire" });
  });

  it("9. processStartedAtMs clamps the idle floor after a restart", () => {
    const action = act({
      shell: shell({ updatedAt: iso(NOW - 6 * HOUR) }),
      processStartedAtMs: NOW - 30_000,
    });
    expect(action).toMatchObject({ type: "stand_down", reason: "not_idle" });
  });

  it("10. an unparseable updatedAt yields no NaN and does not fire", () => {
    const facts = resolveTrigger(input({ shell: shell({ updatedAt: "not-a-timestamp" }) }));
    expect(facts.idleForMs).toBe(0);
    expect(Number.isNaN(facts.idleForMs)).toBe(false);
    expect(act({ shell: shell({ updatedAt: "not-a-timestamp" }) })).toMatchObject({
      type: "stand_down",
      reason: "not_idle",
    });
  });

  it("11. an updatedAt in the future yields idle 0, not a negative", () => {
    const facts = resolveTrigger(input({ shell: shell({ updatedAt: iso(NOW + HOUR) }) }));
    expect(facts.idleForMs).toBe(0);
  });
});

describe("decide — 1.1b deference to the agent's own scheduler", () => {
  const selfPaced = (entries: ReadonlyArray<CronEntry>, o: Partial<LoopDecisionInput> = {}) =>
    act({ record: record({ crons: crons(entries) }), ...o });

  it("11b. a wake inside the threshold window stands the loop down, budget untouched", () => {
    const rec = record({ crons: crons([entry({ nextFireAtMs: NOW + 5 * MINUTE })]) });
    expect(act({ record: rec })).toMatchObject({
      type: "stand_down",
      reason: "self_pacing",
      phase: "self_pacing",
      untilMs: NOW + 5 * MINUTE,
    });
    expect(rec.checkInsUsed).toBe(1);
  });

  it("11c. a wake beyond the window but inside the deadline still stands the loop down", () => {
    // A thread waiting on a wake is not idle, whatever the wake's distance inside the run.
    expect(selfPaced([entry({ nextFireAtMs: NOW + 3 * HOUR })])).toMatchObject({
      reason: "self_pacing",
    });
  });

  it("11d. a wake with updatedAt movement after it landed — detected without waiting out the grace", () => {
    const action = selfPaced([entry({ nextFireAtMs: NOW - 30 * MINUTE })], {
      shell: shell({ updatedAt: iso(NOW - 5 * MINUTE) }),
    });
    expect(action).toMatchObject({ type: "stand_down", reason: "not_idle" });
  });

  it("11e. a wake overdue by its grace fires as wake_lost, and the boundary is inclusive", () => {
    const atMs = NOW - 90_000;
    const rec = record({ crons: crons([entry({ nextFireAtMs: atMs })]) });
    const stale = shell({ updatedAt: iso(NOW - 3 * HOUR) });
    expect(decide(input({ record: rec, shell: stale }))).toMatchObject({
      type: "fire",
      kind: "wake_lost",
      degrade: "wake_lost",
    });
    // One millisecond inside the grace, T3 still stands down.
    expect(decide(input({ record: rec, shell: stale, nowMs: NOW - 1 }))).toMatchObject({
      reason: "self_pacing",
    });
  });

  it("11f. no cron record, or a non-Claude thread, falls back to pure staleness", () => {
    expect(act()).toMatchObject({ type: "fire", kind: "check_in", degrade: null });
    // Every non-Claude adapter behaves exactly as it did before deference existed, even if
    // a record somehow carries entries.
    const rec = record({ crons: crons([entry({ nextFireAtMs: NOW + 5 * MINUTE })]) });
    expect(act({ record: rec, shell: shell({ providerName: "codex" }) })).toMatchObject({
      type: "fire",
    });
    expect(resolveWake(input({ record: rec, shell: shell({ providerName: null }) }))).toBeNull();
    // An entry whose schedule did not parse contributes no wake: an unreadable schedule must
    // never stand supervision down.
    const unparseable = record({
      crons: crons([entry({ schedule: "every so often", nextFireAtMs: null })]),
    });
    expect(resolveWake(input({ record: unparseable }))).toBeNull();
    expect(act({ record: unparseable })).toMatchObject({ type: "fire", kind: "check_in" });
  });

  it("11i-b. with several live crons the earliest wake wins, whatever the recorded order", () => {
    const early = entry({ id: "early", nextFireAtMs: NOW + 5 * MINUTE });
    const late = entry({ id: "late", nextFireAtMs: NOW + 90 * MINUTE });
    expect(resolveWake(input({ record: record({ crons: crons([late, early]) }) }))?.cronId).toBe(
      "early",
    );
    expect(resolveWake(input({ record: record({ crons: crons([early, late]) }) }))?.cronId).toBe(
      "early",
    );
  });

  it("11g. a stale record whose session is gone or stopped is not a live wake", () => {
    const rec = record({ crons: crons([entry({ nextFireAtMs: NOW + 5 * MINUTE })]) });
    expect(
      resolveWake(input({ record: rec, shell: shell({ sessionStatus: "stopped" }) })),
    ).toBeNull();
    expect(resolveWake(input({ record: rec, shell: shell({ sessionStatus: null }) }))).toBeNull();
    expect(act({ record: rec, shell: shell({ sessionStatus: "stopped" }) })).toMatchObject({
      type: "fire",
    });
  });

  it("11h. a gate_off degradation is surfaced, never a reason to stand down", () => {
    const rec = record({ degraded: "gate_off", crons: crons([]) });
    expect(act({ record: rec })).toMatchObject({ type: "fire", kind: "check_in" });
    expect(rec.degraded).toBe("gate_off");
  });

  it("11i. two entries for the same cron: the newest wins, and there is one decision", () => {
    const rec = record({
      crons: crons([
        entry({ id: "c", nextFireAtMs: NOW + 5 * MINUTE }),
        entry({ id: "c", nextFireAtMs: NOW - 3 * HOUR }),
      ]),
    });
    const stale = shell({ updatedAt: iso(NOW - 4 * HOUR) });
    expect(resolveWake(input({ record: rec, shell: stale }))?.atMs).toBe(NOW - 3 * HOUR);
    expect(decide(input({ record: rec, shell: stale }))).toMatchObject({
      type: "fire",
      kind: "wake_lost",
    });
  });

  it("11j. a wake past the deadline is not deferred to — T3 paces on its own clock", () => {
    // A recurring `0 9 * * *` recorded against an earlier deadline...
    const recurring = record({
      deadlineAtMs: NOW + HOUR,
      crons: crons([
        entry({ id: "c", schedule: "0 9 * * *", recurring: true, nextFireAtMs: NOW + 20 * HOUR }),
      ]),
    });
    expect(act({ record: recurring })).toMatchObject({ type: "fire", kind: "check_in" });
    // ...and a one-shot pinned days out.
    const oneShot = record({
      deadlineAtMs: NOW + HOUR,
      crons: crons([entry({ nextFireAtMs: NOW + 5 * 24 * HOUR })]),
    });
    expect(act({ record: oneShot })).toMatchObject({ type: "fire", kind: "check_in" });
    expect(resolveWake(input({ record: oneShot }))?.deferrable).toBe(false);
  });

  it("11k. the grace is derived from the entry, so a jittered recurring wake is not lost", () => {
    // A 30-minute wake two minutes late: tolerated, because 10% of 30 minutes is 3.
    const late = record({
      crons: crons([
        entry({ schedule: "*/30 * * * *", recurring: true, nextFireAtMs: NOW - 2 * MINUTE }),
      ]),
    });
    expect(act({ record: late, shell: shell({ updatedAt: iso(NOW - 3 * HOUR) }) })).toMatchObject({
      reason: "self_pacing",
    });

    const graceFor = (schedule: string, recurring: boolean) =>
      resolveWake(
        input({
          record: record({
            crons: crons([entry({ schedule, recurring, nextFireAtMs: NOW - MINUTE })]),
          }),
        }),
      )?.graceMs;
    expect(graceFor("*/30 * * * *", true)).toBe(3 * MINUTE);
    expect(graceFor("*/20 * * * *", true)).toBe(2 * MINUTE);
    expect(graceFor("0 */4 * * *", true)).toBe(15 * MINUTE); // the cap binds
    expect(graceFor("*/10 * * * *", true)).toBe(90_000); // the floor binds
    expect(graceFor("*/30 * * * *", false)).toBe(90_000); // one-shot: the flat floor
    // An unparseable schedule still yields the floor rather than throwing.
    expect(graceFor("every thirty minutes", true)).toBe(90_000);
    expect(wakeGraceMs({ recurring: true, periodMs: 30 * MINUTE }, config)).toBe(3 * MINUTE);
  });

  it("11l. a record with the fail-closed deadline default never defers and never fires", () => {
    const corrupted = record({
      deadlineAtMs: 0,
      crons: crons([entry({ nextFireAtMs: NOW + MINUTE })]),
    });
    const action = act({ record: corrupted });
    expect(action).toMatchObject({ type: "stop", outcome: "spent", cause: "deadline" });
    expect(action.type).not.toBe("stand_down");
  });
});

describe("decide — 1.2 budget and deadline", () => {
  it("12. budget remaining is allowed to fire", () => {
    expect(act({ record: record({ checkInsUsed: 5, maxCheckIns: 6 }) })).toMatchObject({
      type: "fire",
      checkIn: { n: 6, of: 6 },
    });
  });

  it("13. an exhausted budget stops the run", () => {
    expect(act({ record: record({ checkInsUsed: 6, maxCheckIns: 6 }) })).toMatchObject({
      type: "stop",
      outcome: "spent",
      cause: "budget",
    });
  });

  it("14. a passed deadline stops the run even with budget left", () => {
    expect(act({ record: record({ deadlineAtMs: NOW - MINUTE, checkInsUsed: 0 }) })).toMatchObject({
      type: "stop",
      outcome: "spent",
      cause: "deadline",
    });
  });

  it("15. a deadline that did not survive a write means over, never unbounded", () => {
    expect(act({ record: record({ deadlineAtMs: 0 }) })).toMatchObject({
      type: "stop",
      outcome: "spent",
    });
  });

  it("15b. the deadline stops the loop while the thread is busy", () => {
    // Guard 4b is swept before every skip for exactly this: a thread that never goes idle
    // used to walk through its own deadline indefinitely.
    const busy = shell({ sessionStatus: "running", updatedAt: iso(NOW - MINUTE) });
    expect(act({ shell: busy, record: record({ deadlineAtMs: NOW - MINUTE }) })).toMatchObject({
      type: "stop",
      outcome: "spent",
      cause: "deadline",
    });
  });

  it("15c. the sentinel is honoured while the thread is busy", () => {
    const busy = shell({ sessionStatus: "running", updatedAt: iso(NOW - MINUTE) });
    expect(act({ shell: busy, sentinelAtMs: NOW - MINUTE })).toMatchObject({
      type: "stop",
      outcome: "done",
      cause: "sentinel",
    });
  });

  it("16. a deadline already past at arm time stops on the first evaluation", () => {
    // The route rejects this with `400 deadline_required`/a past deadline; if one reaches
    // the table anyway it is over, not unbounded.
    const armedIntoThePast = record({
      armedAtMs: NOW,
      deadlineAtMs: NOW - HOUR,
      lastCheckIn: null,
    });
    expect(act({ record: armedIntoThePast })).toMatchObject({ type: "stop", outcome: "spent" });
  });

  it("17. `spent` is reported as `spent`, never as `done`", () => {
    const action = act({ record: record({ checkInsUsed: 6, maxCheckIns: 6 }) });
    expect(action.type).toBe("stop");
    if (action.type !== "stop") return;
    expect(action.outcome).toBe("spent");
    expect(action.outcome === "done").toBe(false);
  });

  it("a bound that cannot stop the agent is not a bound: spent ends the session when wakes are pending", () => {
    const pending = crons([entry({ recurring: true, nextFireAtMs: NOW + 20 * MINUTE })]);
    const spent = act({ record: record({ deadlineAtMs: NOW - 1, crons: pending }) });
    expect(spent).toMatchObject({ outcome: "spent", stopSession: true });
    // Nothing recorded means nothing to stop.
    expect(act({ record: record({ deadlineAtMs: NOW - 1 }) })).toMatchObject({
      stopSession: false,
    });
    // `done` leaves the session alone: the agent said it finished, and killing it would take
    // any live background work with it.
    expect(act({ record: record({ crons: pending }), sentinelAtMs: NOW - MINUTE })).toMatchObject({
      outcome: "done",
      stopSession: false,
    });
    // ...and so does a takeover, where the session is the turn the human just started.
    expect(
      act({
        record: record({
          crons: pending,
          lastCheckIn: { firedAtMs: NOW - HOUR, createdAtIso: iso(NOW - HOUR) },
        }),
        shell: shell({ latestUserMessageAt: iso(NOW - MINUTE) }),
      }),
    ).toMatchObject({ outcome: "handed-back", stopSession: false });
  });
});

describe("decide — 1.3 strikes", () => {
  const firedAtMs = NOW - HOUR;
  const lastCheckIn = { firedAtMs, createdAtIso: iso(firedAtMs) };

  it("18. movement at or above productiveMs resets strikes to zero", () => {
    const action = act({
      record: record({ lastCheckIn, strikes: 1 }),
      shell: shell({ updatedAt: iso(firedAtMs + config.productiveMs) }),
    });
    expect(action).toMatchObject({
      type: "fire",
      checkIn: { previousOutcome: "productive", strikes: 0 },
    });
  });

  it("19. movement below productiveMs takes a strike", () => {
    const action = act({
      record: record({ lastCheckIn, strikes: 0 }),
      shell: shell({ updatedAt: iso(firedAtMs + 30_000) }),
    });
    expect(action).toMatchObject({
      type: "fire",
      checkIn: { previousOutcome: "unproductive", strikes: 1 },
    });
  });

  it("20. two consecutive unproductive check-ins stop the run as stalled", () => {
    expect(
      act({
        record: record({ lastCheckIn, strikes: 1 }),
        shell: shell({ updatedAt: iso(firedAtMs + 30_000) }),
      }),
    ).toMatchObject({ type: "stop", outcome: "stalled", cause: "strikes" });
  });

  it("21. unproductive, productive, unproductive is still running (strikes are consecutive)", () => {
    const afterProductive = act({
      record: record({ lastCheckIn, strikes: 1 }),
      shell: shell({ updatedAt: iso(firedAtMs + 10 * MINUTE) }),
    });
    expect(afterProductive).toMatchObject({ type: "fire", checkIn: { strikes: 0 } });
    const afterReset = act({
      record: record({ lastCheckIn, strikes: 0 }),
      shell: shell({ updatedAt: iso(firedAtMs + 30_000) }),
    });
    expect(afterReset).toMatchObject({ type: "fire", checkIn: { strikes: 1 } });
  });

  it("22. strikes are only judged once a check-in exists to judge against", () => {
    const action = act({ record: record({ lastCheckIn: null, strikes: 1 }) });
    expect(action).toMatchObject({
      type: "fire",
      checkIn: { previousOutcome: "unknown", strikes: 1 },
    });
    // Nor can an unreadable updatedAt manufacture a strike.
    expect(
      judgeProgress(
        input({ record: record({ lastCheckIn }), shell: shell({ updatedAt: "junk" }) }),
      ),
    ).toEqual({ outcome: "unknown", strikes: 0 });
    expect(judgeProgress(input({ record: record({ lastCheckIn }), shell: null }))).toEqual({
      outcome: "unknown",
      strikes: 0,
    });
  });

  it("a durable two-strike record stops on the sweep, before anything can skip", () => {
    expect(
      act({
        record: record({ strikes: 2, rateLimitedUntilMs: NOW + HOUR }),
      }),
    ).toMatchObject({ type: "stop", outcome: "stalled", cause: "strikes", stopSession: false });
  });
});

describe("decide — 1.4 terminal stickiness", () => {
  const stopped = { reason: "done", atMs: NOW - HOUR, detail: "sentinel" } as const;

  it("23. a stopped record never fires, whatever else is true", () => {
    expect(
      act({
        record: record({ stopped, checkInsUsed: 0, deadlineAtMs: NOW + 8 * HOUR }),
        shell: shell({ updatedAt: iso(NOW - 8 * HOUR) }),
      }),
    ).toMatchObject({ type: "stand_down", reason: "stopped", phase: "off" });
  });

  it("24. a terminal state survives a decision pass unchanged", () => {
    const rec = record({ stopped });
    decide(input({ record: rec }));
    expect(rec.stopped).toEqual(stopped);
    expect(rec.armed).toBe(true);
  });

  it("25. a re-armed record fires again: the table keeps no memory of the last run", () => {
    const rearmed = record({
      stopped: null,
      checkInsUsed: 0,
      strikes: 0,
      armedAtMs: NOW - MINUTE,
      lastCheckIn: null,
    });
    expect(act({ record: rearmed })).toMatchObject({
      type: "fire",
      checkIn: { n: 1, of: 6, firedAtMs: NOW },
    });
  });
});

describe("decide — 1.5 handback", () => {
  const firedAtMs = NOW - HOUR;
  const lastCheckIn = { firedAtMs, createdAtIso: iso(firedAtMs) };

  it("26. a user message newer than our nudge hands the loop back", () => {
    expect(
      act({
        record: record({ lastCheckIn }),
        shell: shell({ latestUserMessageAt: iso(NOW - MINUTE) }),
      }),
    ).toMatchObject({ type: "stop", outcome: "handed-back", cause: "takeover" });
  });

  it("27. our own minted createdAt is not a takeover (exact string compare)", () => {
    expect(
      act({
        record: record({ lastCheckIn }),
        shell: shell({ latestUserMessageAt: lastCheckIn.createdAtIso }),
      }),
    ).toMatchObject({ type: "fire" });
  });

  it("28. handback does not reset the budget", () => {
    const rec = record({ lastCheckIn, checkInsUsed: 3, strikes: 1 });
    const action = act({
      record: rec,
      shell: shell({ latestUserMessageAt: iso(NOW - MINUTE) }),
    });
    expect(action).toMatchObject({ type: "stop", outcome: "handed-back" });
    expect(rec.checkInsUsed).toBe(3);
    expect(rec.strikes).toBe(1);
    expect(action).not.toHaveProperty("checkIn");
  });

  it("29. armed but never fired: armedAtMs is the baseline", () => {
    const rec = record({ lastCheckIn: null, armedAtMs: NOW - HOUR });
    expect(
      act({ record: rec, shell: shell({ latestUserMessageAt: iso(NOW - MINUTE) }) }),
    ).toMatchObject({ outcome: "handed-back" });
    expect(
      act({ record: rec, shell: shell({ latestUserMessageAt: iso(NOW - 2 * HOUR) }) }),
    ).toMatchObject({ type: "fire" });
  });
});

describe("decide — the remaining outcomes", () => {
  it("passes a disarm straight through", () => {
    expect(act({ shell: null })).toEqual({ type: "disarm", reason: "thread_gone" });
  });

  it("resolveTrigger reports neutral facts for a thread that is gone", () => {
    expect(resolveTrigger(input({ shell: null }))).toEqual({
      idleForMs: 0,
      thresholdMs: 15 * MINUTE,
      busyTurn: false,
      wake: null,
    });
  });

  it("carries the keep-active pin repair and the reservation the reactor persists", () => {
    expect(act({ shell: shell({ settledOverride: "active" }) })).toEqual({
      type: "fire",
      kind: "check_in",
      repairPin: true,
      degrade: null,
      checkIn: { n: 2, of: 6, firedAtMs: NOW, strikes: 0, previousOutcome: "unknown" },
    });
  });
});
