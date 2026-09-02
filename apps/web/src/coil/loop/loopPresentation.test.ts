import { describe, expect, it } from "vite-plus/test";

import type { LoopBlocker, LoopDerived, LoopRecord, LoopUserInput, LoopView } from "./loopClient";
import {
  canRenderLoopConsole,
  countWaiting,
  describeBlockingHint,
  describeCheckInRow,
  describeEmptyState,
  describeLoopState,
  describeRefusal,
  describeStop,
  formatAge,
  formatClock,
  formatDuration,
  fromDateTimeLocalValue,
  hasQuestionSections,
  partitionBlockers,
  partitionUserInputs,
  resolveDeferredChannelNotice,
  seedArmDraft,
  summariseBounds,
  toDateTimeLocalValue,
} from "./loopPresentation";

const NOW_MS = Date.UTC(2026, 8, 2, 9, 4, 0);
const DEADLINE_MS = Date.UTC(2026, 8, 2, 7, 0, 0);

const record = (overrides: Partial<LoopRecord> = {}): LoopRecord => ({
  armed: true,
  armedAtMs: NOW_MS - 10 * 3_600_000,
  goal: null,
  maxCheckIns: 6,
  checkInsUsed: 2,
  deadlineAtMs: DEADLINE_MS,
  idleMs: 15 * 60_000,
  busyIdleMs: 45 * 60_000,
  degraded: null,
  userInputs: [],
  checkIns: [],
  strikes: 0,
  rateLimitedUntilMs: 0,
  stopped: null,
  overridePrompt: null,
  blockers: [],
  ...overrides,
});

const derived = (overrides: Partial<LoopDerived> = {}): LoopDerived => ({
  state: "watching",
  reason: null,
  stoppedReason: null,
  checkInsUsed: 2,
  maxCheckIns: 6,
  deadlineAtMs: DEADLINE_MS,
  msUntilDeadline: 0,
  rateLimitedUntilMs: 0,
  nextWakeAtMs: null,
  snoozedUntilMs: null,
  threadKnown: true,
  globalEnabled: true,
  armedCount: 1,
  maxArmedThreads: 3,
  ...overrides,
});

const view = (overrides: Partial<LoopView> = {}): LoopView => ({
  threadId: "thread-a",
  record: record(),
  derived: derived(),
  blockers: [],
  ledger: [],
  ...overrides,
});

const blocker = (overrides: Partial<LoopBlocker> = {}): LoopBlocker => ({
  id: "b1",
  raisedAtMs: NOW_MS - 3_600_000,
  question: "Migrate in place or backfill?",
  options: [],
  context: null,
  answeredAtMs: null,
  answer: null,
  deliveredToAgent: false,
  ...overrides,
});

const userInput = (overrides: Partial<LoopUserInput> = {}): LoopUserInput => ({
  requestId: "r1",
  raisedAtMs: NOW_MS - 3_600_000,
  dialogKind: null,
  question: "Which table?",
  resolution: null,
  resolvedAtMs: null,
  ...overrides,
});

describe("describeStop", () => {
  // The failure this whole feature exists to stop: a run that hit a bound reading as a success.
  it("never gives spent the done tone", () => {
    expect(describeStop("done").tone).toBe("done");
    expect(describeStop("spent").tone).toBe("spent");
    expect(describeStop("spent").tone).not.toBe("done");
    expect(describeStop("stalled").tone).not.toBe("done");
    expect(describeStop("handed-back").tone).not.toBe("done");
  });

  it("says out loud that a spent run did not finish", () => {
    expect(describeStop("spent").detail).toContain("did not finish");
  });

  it("states that handing back did not reset the budget", () => {
    expect(describeStop("handed-back").detail).toContain("not reset");
  });
});

describe("describeLoopState", () => {
  it("reads a terminal state through its stop reason, not through the live guards", () => {
    const copy = describeLoopState(derived({ state: "stopped", stoppedReason: "spent" }));
    expect(copy.label).toBe("Out of rope");
    expect(copy.tone).toBe("spent");
  });

  it("defaults a terminal with no reason to spent rather than to done", () => {
    expect(describeLoopState(derived({ state: "stopped", stoppedReason: null })).tone).toBe(
      "spent",
    );
  });

  it("says standing down is not a disarm", () => {
    const copy = describeLoopState(derived({ state: "standing_down", reason: "disabled" }));
    expect(copy.tone).toBe("muted");
    expect(copy.detail).toContain("nothing was disarmed");
  });

  it("distinguishes held from stalled — no check-in was spent", () => {
    const copy = describeLoopState(
      derived({ state: "held", reason: "rate_limited", rateLimitedUntilMs: DEADLINE_MS }),
    );
    expect(copy.tone).toBe("held");
    expect(copy.detail).toContain("No check-in was spent");
  });

  it("names the agent's own wake when self-pacing", () => {
    const copy = describeLoopState(derived({ state: "self_pacing", nextWakeAtMs: DEADLINE_MS }));
    expect(copy.detail).toContain("stands by and spends nothing");
  });

  it("falls back to a generic sentence for a reason it has no copy for", () => {
    const copy = describeLoopState(derived({ state: "standing_down", reason: "check_in_floor" }));
    expect(copy.detail).toContain("budget and deadline are intact");
  });
});

describe("partitionBlockers", () => {
  // Answered and "the agent knows" are different facts: the answer banks until the next check-in.
  it("splits open, banked and delivered", () => {
    const open = blocker({ id: "open" });
    const banked = blocker({ id: "banked", answeredAtMs: NOW_MS, answer: "yes" });
    const delivered = blocker({
      id: "delivered",
      answeredAtMs: NOW_MS,
      answer: "yes",
      deliveredToAgent: true,
    });
    const partition = partitionBlockers([open, banked, delivered]);
    expect(partition.open.map((entry) => entry.id)).toEqual(["open"]);
    expect(partition.banked.map((entry) => entry.id)).toEqual(["banked"]);
    expect(partition.delivered.map((entry) => entry.id)).toEqual(["delivered"]);
  });
});

describe("partitionUserInputs", () => {
  // A voided question is one nobody ever saw. Upstream leaves no other trace of it.
  it("keeps voided distinct from answered", () => {
    const partition = partitionUserInputs([
      userInput({ requestId: "open" }),
      userInput({ requestId: "answered", resolution: "answered", resolvedAtMs: NOW_MS }),
      userInput({ requestId: "voided", resolution: "voided", resolvedAtMs: NOW_MS }),
    ]);
    expect(partition.open.map((entry) => entry.requestId)).toEqual(["open"]);
    expect(partition.answered.map((entry) => entry.requestId)).toEqual(["answered"]);
    expect(partition.voided.map((entry) => entry.requestId)).toEqual(["voided"]);
  });
});

describe("resolveDeferredChannelNotice", () => {
  it("names the missing channel when agent browser access is off", () => {
    const notice = resolveDeferredChannelNotice({
      browserAccessKnown: true,
      browserAccessEnabled: false,
    });
    expect(notice).not.toBeNull();
    expect(notice?.detail).toContain("Settings → Integrations");
    // The whole point: an empty list must not read as "it had nothing to ask".
    expect(notice?.detail).toContain("does not mean");
  });

  it("says nothing when the channel is available", () => {
    expect(
      resolveDeferredChannelNotice({ browserAccessKnown: true, browserAccessEnabled: true }),
    ).toBeNull();
  });

  it("says nothing rather than guessing when the setting cannot be read", () => {
    expect(
      resolveDeferredChannelNotice({ browserAccessKnown: false, browserAccessEnabled: false }),
    ).toBeNull();
  });
});

describe("describeRefusal", () => {
  it("keeps the server's code alongside the sentence", () => {
    const refusal = describeRefusal("deadline_required");
    expect(refusal.code).toBe("deadline_required");
    expect(refusal.message).toContain("end time");
  });

  it("words thread_snoozed as the unsnooze-first rule rather than a generic failure", () => {
    expect(describeRefusal("thread_snoozed").message).toContain("Unsnooze");
  });

  it("still carries an unknown code so a refusal is never blank", () => {
    const refusal = describeRefusal("some_future_code");
    expect(refusal.code).toBe("some_future_code");
    expect(refusal.message).not.toBe("");
  });
});

describe("describeEmptyState", () => {
  // The acceptance case: spent, and the model never called raise_blocker.
  it("still says what happened for a spent run with no blockers", () => {
    const empty = describeEmptyState(
      view({
        record: record({
          armed: false,
          checkInsUsed: 6,
          stopped: { reason: "spent", atMs: DEADLINE_MS, detail: "deadline reached" },
          checkIns: [
            {
              n: 6,
              firedAtMs: DEADLINE_MS - 3_600_000,
              createdAtIso: "2026-09-02T06:00:00.000Z",
              activityCursor: "c6",
              outcome: "productive",
            },
          ],
        }),
        derived: derived({ state: "stopped", stoppedReason: "spent", checkInsUsed: 6 }),
      }),
      NOW_MS,
    );
    expect(empty.headline).toBe("Stopped. Nothing is waiting on you.");
    expect(empty.lines.join(" ")).toContain("did not finish");
    expect(empty.lines.join(" ")).toContain("deadline reached");
    expect(empty.lines.join(" ")).toContain("Used 6 of 6 check-ins");
    expect(empty.lines.some((line) => line.includes("Last activity"))).toBe(true);
  });

  it("says so when a run ended without ever checking in", () => {
    const empty = describeEmptyState(
      view({
        record: record({ armed: false, stopped: { reason: "spent", atMs: 1, detail: "" } }),
        derived: derived({ state: "stopped", stoppedReason: "spent" }),
      }),
      NOW_MS,
    );
    expect(empty.lines.some((line) => line.includes("never checked in"))).toBe(true);
  });

  it("does not call a finished run stopped", () => {
    const empty = describeEmptyState(
      view({
        record: record({ armed: false, stopped: { reason: "done", atMs: 1, detail: "" } }),
        derived: derived({ state: "stopped", stoppedReason: "done" }),
      }),
      NOW_MS,
    );
    expect(empty.headline).toBe("Finished. Nothing is waiting on you.");
  });

  it("offers to arm when there is no loop at all", () => {
    const empty = describeEmptyState(
      view({ record: record({ armed: false }), derived: derived({ state: "off" }) }),
      NOW_MS,
    );
    expect(empty.headline).toBe("No loop on this thread.");
  });
});

describe("countWaiting", () => {
  it("counts open blockers and open native questions, and nothing else", () => {
    expect(
      countWaiting(
        view({
          record: record({
            blockers: [
              blocker({ id: "a" }),
              blocker({ id: "b", answeredAtMs: NOW_MS, answer: "x" }),
            ],
            userInputs: [
              userInput({ requestId: "open" }),
              userInput({ requestId: "voided", resolution: "voided", resolvedAtMs: NOW_MS }),
            ],
          }),
        }),
      ),
    ).toBe(2);
  });
});

describe("summariseBounds", () => {
  it("drops the deadline rather than printing the epoch when there is none", () => {
    expect(summariseBounds(derived({ deadlineAtMs: 0 }))).toBe("2 of 6 check-ins");
  });
});

describe("formatDuration", () => {
  it("rounds down, so a bound never reads longer than it is", () => {
    expect(formatDuration(59_999)).toBe("0m");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(8 * 3_600_000)).toBe("8h");
    expect(formatDuration(51 * 3_600_000)).toBe("2d 3h");
  });
});

describe("formatAge", () => {
  it("never reports a negative age against a skewed clock", () => {
    expect(formatAge(NOW_MS + 60_000, NOW_MS)).toBe("just now");
  });
});

describe("describeCheckInRow", () => {
  // Derived facts only. A model-authored summary of its own night is exactly what we do not show.
  it("reports the judged outcome, not a narrative", () => {
    expect(
      describeCheckInRow({
        n: 1,
        firedAtMs: NOW_MS,
        createdAtIso: "",
        activityCursor: "",
        outcome: "unproductive",
      }),
    ).toContain("nothing moved");
  });
});

describe("seedArmDraft", () => {
  it("seeds the deadline from defaultRunMs, which is a form seed and never a server fallback", () => {
    const draft = seedArmDraft({
      settings: {
        enabled: true,
        maxArmedThreads: 3,
        defaultMaxCheckIns: 4,
        defaultRunMs: 2 * 3_600_000,
        defaultIdleMs: 15 * 60_000,
        defaultBusyIdleMs: 45 * 60_000,
        armedCount: 0,
      },
      record: record({ maxCheckIns: 0, deadlineAtMs: 0, goal: null }),
      nowMs: NOW_MS,
    });
    expect(draft.maxCheckIns).toBe(4);
    expect(draft.deadlineAtMs).toBe(NOW_MS + 2 * 3_600_000);
  });

  it("keeps the run's own bounds when they are still ahead", () => {
    const draft = seedArmDraft({
      settings: null,
      record: record({ maxCheckIns: 9, deadlineAtMs: NOW_MS + 60_000, goal: "ship it" }),
      nowMs: NOW_MS,
    });
    expect(draft).toEqual({ goal: "ship it", maxCheckIns: 9, deadlineAtMs: NOW_MS + 60_000 });
  });

  it("re-seeds a deadline that has already passed", () => {
    const draft = seedArmDraft({
      settings: null,
      record: record({ deadlineAtMs: NOW_MS - 1 }),
      nowMs: NOW_MS,
    });
    expect(draft.deadlineAtMs).toBe(NOW_MS + 8 * 3_600_000);
  });
});

describe("datetime-local round trip", () => {
  it("survives a round trip in the reader's own timezone", () => {
    const at = new Date(2026, 8, 2, 23, 30, 0, 0).getTime();
    expect(fromDateTimeLocalValue(toDateTimeLocalValue(at))).toBe(at);
  });

  it("reads an empty or half-typed field as no deadline at all", () => {
    expect(fromDateTimeLocalValue("")).toBeNull();
    expect(fromDateTimeLocalValue("2026-09-")).toBeNull();
  });
});

describe("formatClock and the date", () => {
  const SEVEN_AM_TODAY = Date.UTC(2026, 8, 2, 7, 0, 0);
  const SEVEN_AM_TOMORROW = Date.UTC(2026, 8, 3, 7, 0, 0);

  it("prints the time alone for today", () => {
    expect(formatClock(SEVEN_AM_TODAY, NOW_MS)).toBe(formatClock(SEVEN_AM_TODAY));
  });

  it("carries the date when the instant is not today", () => {
    // Loops run overnight: a run armed at 23:00 ends tomorrow, and a bare `07:00` on it reads
    // as eight hours in the PAST rather than eight hours away.
    const withDate = formatClock(SEVEN_AM_TOMORROW, NOW_MS);
    expect(withDate).not.toBe(formatClock(SEVEN_AM_TOMORROW));
    expect(withDate).toContain(formatClock(SEVEN_AM_TOMORROW));
  });

  it("prints the time alone when there is no clock to compare against", () => {
    // `lastLoadedAtMs` is null before the first load lands; guessing "not today" there would
    // put a date on every timestamp in the panel for one render.
    expect(formatClock(SEVEN_AM_TOMORROW, 0)).toBe(formatClock(SEVEN_AM_TOMORROW));
  });

  it("carries into the bounds summary a reader actually looks at", () => {
    expect(summariseBounds(derived({ deadlineAtMs: SEVEN_AM_TOMORROW }), NOW_MS)).toContain(
      formatClock(SEVEN_AM_TOMORROW, NOW_MS),
    );
  });
});

describe("describeLoopState — held is two different facts", () => {
  it("words a snooze as a snooze, not as a usage limit", () => {
    const copy = describeLoopState(
      derived({ state: "held", reason: "snoozed", snoozedUntilMs: DEADLINE_MS }),
      NOW_MS,
    );
    expect(copy.label).toBe("Snoozed");
    expect(copy.detail).not.toContain("Usage limit");
    expect(copy.detail).toContain("picks up where it left off");
  });
});

describe("describeBlockingHint", () => {
  it("points at the composer for a question that is answerable there", () => {
    expect(describeBlockingHint(derived({ state: "blocked", reason: "pending_input" }))).toContain(
      "composer below",
    );
  });

  it("tells a snoozed thread to unsnooze rather than to answer something", () => {
    // There is no prompt in the composer to answer: the human snoozed the thread themselves,
    // and sending them looking for one is a dead end.
    const hint = describeBlockingHint(derived({ state: "held", reason: "snoozed" }));
    expect(hint).toContain("snoozed");
    expect(hint).not.toContain("composer");
  });

  it("says nothing about a thread that is simply running", () => {
    expect(describeBlockingHint(derived())).toBeNull();
  });
});

describe("hasQuestionSections", () => {
  const channel = { browserAccessKnown: true, browserAccessEnabled: true };

  it("is false when every recorded question was already answered", () => {
    // The failure: `userInputs` was non-empty so the console suppressed the empty-state card,
    // but every section rendered its own empty branch — so a finished run explained nothing.
    const answered = view({
      record: record({
        armed: false,
        stopped: { reason: "spent", atMs: NOW_MS, detail: "budget" },
        userInputs: [userInput({ resolution: "answered", resolvedAtMs: NOW_MS })],
      }),
      derived: derived({ state: "stopped", stoppedReason: "spent" }),
    });
    expect(hasQuestionSections(answered, channel)).toBe(false);
    expect(describeEmptyState(answered, NOW_MS).headline).toContain("Stopped");
  });

  it("is true while a question is open, or was voided", () => {
    expect(
      hasQuestionSections(view({ record: record({ userInputs: [userInput()] }) }), channel),
    ).toBe(true);
    expect(
      hasQuestionSections(
        view({ record: record({ userInputs: [userInput({ resolution: "voided" })] }) }),
        channel,
      ),
    ).toBe(true);
  });

  it("is true for an answered blocker, which the deferred section still shows", () => {
    const banked = blocker({ answeredAtMs: NOW_MS, answer: "in place" });
    expect(hasQuestionSections(view({ record: record({ blockers: [banked] }) }), channel)).toBe(
      true,
    );
  });

  it("raises the missing-channel warning only on a thread that has a loop", () => {
    const off = { browserAccessKnown: true, browserAccessEnabled: false };
    // No loop here and none ever: nothing would have used the channel, so warning about it is
    // noise on every thread in the app rather than a fact about this one.
    const noLoop = view({
      record: record({ armed: false }),
      derived: derived({ state: "off" }),
    });
    expect(hasQuestionSections(noLoop, off)).toBe(false);
    expect(hasQuestionSections(view(), off)).toBe(true);
    const ended = view({
      record: record({ armed: false, stopped: { reason: "done", atMs: NOW_MS, detail: "" } }),
      derived: derived({ state: "stopped", stoppedReason: "done" }),
    });
    expect(hasQuestionSections(ended, off)).toBe(true);
  });
});

describe("canRenderLoopConsole", () => {
  it("renders on a thread in the primary environment", () => {
    expect(
      canRenderLoopConsole({ primaryEnvironmentId: "env-1", threadEnvironmentId: "env-1" }),
    ).toBe(true);
  });

  it("renders nothing rather than answering for another environment's thread", () => {
    // Every fork route is called against the primary environment, so this would report "no
    // loop on this thread" for a loop that may well be armed — and arming would 404.
    expect(
      canRenderLoopConsole({ primaryEnvironmentId: "env-1", threadEnvironmentId: "env-2" }),
    ).toBe(false);
  });

  it("does not treat an unresolved primary as a mismatch", () => {
    expect(canRenderLoopConsole({ primaryEnvironmentId: null, threadEnvironmentId: "env-2" })).toBe(
      true,
    );
  });
});

describe("describeRefusal — the armed preconditions", () => {
  it("words both 409s rather than falling back to the generic sentence", () => {
    expect(describeRefusal("not_armed").message).toContain("not running");
    expect(describeRefusal("armed").message).toContain("Disarm it first");
  });
});
