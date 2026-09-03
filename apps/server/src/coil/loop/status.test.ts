// @effect-diagnostics globalDate:off -- `iso` is a pure ms->ISO fixture helper anchored on a
// fixed constant, never a wall-clock reading.
/**
 * The shell-free status derivation `loop_status` answers from, and the property the tool
 * depends on: every input produces a status, and a missing shell is skipped rather than
 * reported as a state.
 */

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_GLOBAL_SETTINGS, EMPTY_RECORD, type LoopRecord } from "./state.ts";
import { deriveLoopStatus, earliestWakeMs } from "./status.ts";
import type { LoopThreadShell } from "./types.ts";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

const globalSettings = (o: Partial<typeof DEFAULT_GLOBAL_SETTINGS> = {}) => ({
  ...DEFAULT_GLOBAL_SETTINGS,
  enabled: true,
  ...o,
});

const record = (o: Partial<LoopRecord> = {}): LoopRecord => ({
  ...EMPTY_RECORD,
  armed: true,
  armedAtMs: NOW - 2 * HOUR,
  maxCheckIns: 6,
  checkInsUsed: 2,
  deadlineAtMs: NOW + 4 * HOUR,
  ...o,
});

const shell = (o: Partial<LoopThreadShell> = {}): LoopThreadShell =>
  ({
    updatedAt: iso(NOW - 20 * MINUTE),
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...o,
  }) as unknown as LoopThreadShell;

const derive = (o: {
  record?: LoopRecord;
  global?: typeof DEFAULT_GLOBAL_SETTINGS;
  shell?: LoopThreadShell | null;
}) =>
  deriveLoopStatus({
    nowMs: NOW,
    record: o.record ?? record(),
    global: o.global ?? globalSettings(),
    shell: o.shell ?? null,
  });

describe("deriveLoopStatus", () => {
  it("reports the live budget and the time left", () => {
    const status = derive({});
    expect(status).toMatchObject({
      armed: true,
      state: "watching",
      reason: null,
      checkInsUsed: 2,
      maxCheckIns: 6,
      deadlineAtMs: NOW + 4 * HOUR,
      msToDeadline: 4 * HOUR,
    });
  });

  it("clamps a passed deadline at zero rather than reporting negative time", () => {
    expect(derive({ record: record({ deadlineAtMs: NOW - HOUR }) }).msToDeadline).toBe(0);
  });

  it("puts a terminal state ahead of every live reading, including the master toggle", () => {
    const stopped = record({
      stopped: { reason: "spent", atMs: NOW - MINUTE, detail: "budget" },
    });
    expect(derive({ record: stopped, global: globalSettings({ enabled: false }) })).toMatchObject({
      armed: false,
      state: "stopped",
      reason: "spent",
    });
  });

  it("reports an unarmed thread as off with no-loop, never as a guard's opinion of it", () => {
    expect(derive({ record: EMPTY_RECORD })).toMatchObject({
      armed: false,
      state: "off",
      reason: "no-loop",
    });
  });

  it("reads the master toggle as standing down, and as not supervised", () => {
    // The record stays armed — the toggle disarms nothing — but nothing will nudge this
    // thread, so the agent-facing answer to "am I being watched" is no.
    expect(derive({ global: globalSettings({ enabled: false }) })).toMatchObject({
      armed: false,
      state: "standing_down",
      reason: "disabled",
    });
  });

  it("reports a durable rate limit as held", () => {
    expect(derive({ record: record({ rateLimitedUntilMs: NOW + 30 * MINUTE }) })).toMatchObject({
      state: "held",
      reason: "rate_limited",
    });
  });

  it("reports a wake still ahead of us and inside the deadline as self-pacing", () => {
    const withWake = record({
      crons: {
        recordedAtMs: NOW - HOUR,
        entries: [
          {
            id: "cron-1",
            schedule: "*/30 * * * *",
            recurring: true,
            prompt: "keep going",
            nextFireAtMs: NOW + 20 * MINUTE,
          },
        ],
      },
    });
    expect(derive({ record: withWake })).toMatchObject({
      state: "self_pacing",
      nextWakeAtMs: NOW + 20 * MINUTE,
    });
  });

  it("leaves a wake past due to the reactor, since only it knows the grace", () => {
    const late = record({
      crons: {
        recordedAtMs: NOW - HOUR,
        entries: [
          {
            id: "cron-1",
            schedule: "*/30 * * * *",
            recurring: true,
            prompt: "keep going",
            nextFireAtMs: NOW - MINUTE,
          },
        ],
      },
    });
    expect(derive({ record: late }).state).toBe("watching");
  });

  it("skips the shell clauses when there is no shell instead of guessing at them", () => {
    // The MCP tool always passes null. Reading that as "thread gone" would have
    // `loop_status` tell a running agent its own thread does not exist.
    expect(derive({ shell: null }).state).toBe("watching");
  });

  it("uses the shell clauses when a shell is supplied", () => {
    // `held`, matching guard 6's phase and the route's `derived`: a snooze is a bounded hold
    // with an expiry, not a question waiting on an answer. One fact, one word.
    expect(derive({ shell: shell({ snoozedUntil: iso(NOW + HOUR) }) })).toMatchObject({
      state: "held",
      reason: "snoozed",
    });
    expect(derive({ shell: shell({ hasActionableProposedPlan: true }) })).toMatchObject({
      state: "blocked",
      reason: "pending_plan",
    });
  });
});

describe("earliestWakeMs", () => {
  it("ignores entries that did not parse — null means no deference, not now", () => {
    const entry = (id: string, nextFireAtMs: number | null) => ({
      id,
      schedule: "*/30 * * * *",
      recurring: true,
      prompt: "keep going",
      nextFireAtMs,
    });
    expect(earliestWakeMs(record({ crons: null }))).toBeNull();
    expect(
      earliestWakeMs(record({ crons: { recordedAtMs: NOW, entries: [entry("a", null)] } })),
    ).toBeNull();
    expect(
      earliestWakeMs(
        record({
          crons: {
            recordedAtMs: NOW,
            entries: [entry("a", NOW + HOUR), entry("b", null), entry("c", NOW + MINUTE)],
          },
        }),
      ),
    ).toBe(NOW + MINUTE);
  });
});
