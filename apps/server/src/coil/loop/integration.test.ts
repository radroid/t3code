/**
 * The scenarios that motivated the feature. TESTS.md cases 128–137.
 *
 * Each one replays a real failure, or a real *non*-failure the design must not break. They
 * are heavier than the unit cases on purpose: the reactor, the store, the decision table,
 * the guards, the cron deference and the sentinel are all real, and the only doubles are the
 * projection rows, the engine and the provider stream.
 *
 * The two headline acceptance tests are **136b** (a healthy self-pacing agent must be left
 * completely alone) and **136c** (a wake lost to a restart must be covered exactly once).
 * How rarely this reactor fires is the measure of a correct implementation, so a regression
 * that makes it chattier shows up as a failure here rather than as a surprise at 03:00.
 *
 * @module coil/loop/integration.test
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { LOOP_ACTIVITY_KINDS, LoopReactorLive } from "./Reactor.ts";
import {
  activitiesOfKind,
  advancePolls,
  advanceUntil,
  clearLoopEnv,
  harness,
  HOUR,
  LOOP_THREAD_ID,
  MINUTE,
  msToIso,
  rateLimitEvent,
  settleQuiet,
  threadShell,
  turnStarts,
  turnStartsAtLeast,
  writeSentinel,
} from "./reactorHarness.ts";
import { makeLoopStore, type LoopStoreShape } from "./state.ts";

clearLoopEnv();

type OuterR = Scope.Scope | FileSystem.FileSystem | Path.Path;

const scoped = <A, E>(body: Effect.Effect<A, E, OuterR>) =>
  body.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer())));

const withReactor = <ROut, LE, A, E, R>(
  deps: Layer.Layer<ROut, LE, never>,
  body: Effect.Effect<A, E, R>,
) => body.pipe(Effect.provide(LoopReactorLive.pipe(Layer.provideMerge(deps))));

const arm = (
  store: LoopStoreShape,
  o: {
    readonly threadId?: string;
    readonly maxCheckIns?: number;
    readonly deadlineAtMs?: number;
    readonly armedAtMs?: number;
  } = {},
) =>
  Effect.gen(function* () {
    yield* store.setGlobal({ enabled: true });
    yield* store.arm({
      threadId: o.threadId ?? LOOP_THREAD_ID,
      armedAtMs: o.armedAtMs ?? 0,
      deadlineAtMs: o.deadlineAtMs ?? 8 * HOUR,
      maxCheckIns: o.maxCheckIns ?? 6,
    });
  });

const record = (store: LoopStoreShape, threadId: string = LOOP_THREAD_ID) =>
  store.getThread(threadId);

/**
 * A recurring wake the agent scheduled for itself.
 *
 * `nextFireAtMs` is what the `Stop` hook recorded; `schedule` is the expression the fork
 * parses to derive the grace. A 20-minute period gives a 2-minute grace (10% of the period,
 * floored at 90 s), which is what makes "late but healthy" distinguishable from "lost".
 */
const scheduleWake = (store: LoopStoreShape, nextFireAtMs: number, recordedAtMs: number) =>
  store.setCrons(LOOP_THREAD_ID, {
    recordedAtMs,
    entries: [
      {
        id: "cron-1",
        schedule: "*/20 * * * *",
        recurring: true,
        prompt: "continue the build loop",
        nextFireAtMs,
      },
    ],
  });

describe("Loops — the scenarios that motivated the feature", () => {
  // --- 136b: the regression test for "T3 does not fight the agent" -----------

  it.effect("136b: a healthy self-pacing agent is left completely alone for three hours", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { deadlineAtMs: 8 * HOUR });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          // Three hours of a well-behaved agent: it wakes itself every twenty minutes, and
          // each wake moves `updatedAt`. The reactor should never once decide it is needed.
          for (let wake = 1; wake <= 9; wake++) {
            const wakeAtMs = wake * 20 * MINUTE;
            yield* scheduleWake(h.store, wakeAtMs, wakeAtMs - 20 * MINUTE);
            yield* advancePolls(20);
            // The wake landed: the agent worked, so the row moved just past its own wake.
            yield* Ref.set(h.shellRef, threadShell({ updatedAt: msToIso(wakeAtMs + MINUTE) }));
          }

          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "T3 must not nudge a thread that is pacing itself",
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.checkInsUsed, 0, "and it must spend nothing doing so");
          assert.isTrue(after.armed, "while staying armed, so the deadline still applies");
          assert.isNull(after.degraded, "and nothing is reported as degraded");
        }),
      );
    }).pipe(scoped),
  );

  // --- 136c: the durability gap, as a test ----------------------------------

  it.effect("136c: a wake lost to a restart is noticed and covered exactly once", () =>
    Effect.gen(function* () {
      // The agent scheduled a wake for +25 min. The provider's cron table is in-process
      // (`cron_durable` is false), so a restart at +10 min destroys it and leaves no trace
      // anywhere except T3's own record. This is the one thing T3 can supply that the binary
      // cannot, and it is the strongest trigger in the design.
      const wakeAtMs = 25 * MINUTE;
      const h = yield* harness({ shell: threadShell({ updatedAt: msToIso(5 * MINUTE) }) });
      yield* arm(h.store);
      yield* scheduleWake(h.store, wakeAtMs, 0);

      // The record survives the process that wrote it: a second store over the same file
      // sees the armed run and the wake it was waiting on.
      const rebuilt = yield* makeLoopStore(h.statePath);
      const survived = yield* rebuilt.getThread(LOOP_THREAD_ID);
      assert.isTrue(survived.armed, "the arm survives a restart");
      assert.strictEqual(survived.crons?.entries[0]?.nextFireAtMs, wakeAtMs);

      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          // Up to the wake plus its 2-minute grace, T3 stands by: an overdue wake is not yet
          // a lost one, and firing here would fight a merely jittered scheduler.
          yield* advancePolls(26);
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "a wake one minute late is late, not lost",
          );

          yield* advanceUntil(
            Ref.get(h.dispatched).pipe(
              Effect.map((all) => activitiesOfKind(all, LOOP_ACTIVITY_KINDS.wakeLost).length > 0),
            ),
            "the covered wake",
            20,
          );
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            1,
            "covered exactly once",
          );
          const notes = activitiesOfKind(
            yield* Ref.get(h.dispatched),
            LOOP_ACTIVITY_KINDS.wakeLost,
          );
          assert.strictEqual(notes.length, 1, "and said so, once");
          assert.strictEqual(notes[0]!.tone, "error");
          assert.deepStrictEqual((notes[0]!.payload as { cronId: string }).cronId, "cron-1");
          assert.strictEqual((yield* record(h.store)).degraded, "wake_lost");

          // And it does not keep covering it. The check-in floor and the spent reservation
          // together mean one lost wake costs one check-in.
          yield* advancePolls(10);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 128: the original night ----------------------------------------------

  it.effect("128: the original night — quiet only after the activity stream stops", () =>
    Effect.gen(function* () {
      // The turn completed at 00:19 while `task.*` activities kept arriving until 00:52, then
      // silence. Every one of those activities bumps `updatedAt`, so the trigger must read
      // the thread as busy right through them and fire ~15 minutes after the last one.
      const turnCompletedAtMs = 19 * MINUTE;
      const lastActivityAtMs = 52 * MINUTE;
      const h = yield* harness({
        shell: threadShell({ updatedAt: msToIso(turnCompletedAtMs), latestTurnState: "completed" }),
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          // The turn runs to 00:19 and background subagent work keeps appending activities
          // until 00:52. Both move `updatedAt`, and the fixture keeps it in step with the
          // clock so the reactor sees a thread that never stops moving.
          for (let minute = 1; minute <= 52; minute++) {
            yield* Ref.set(
              h.shellRef,
              threadShell({
                updatedAt: msToIso(minute * MINUTE),
                latestTurnState: minute * MINUTE < turnCompletedAtMs ? "running" : "completed",
              }),
            );
            yield* advancePolls(1);
          }
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "no fire while subagent activity is still arriving",
          );

          // Then silence. Nothing else changes; the row simply stops moving.
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the check-in after silence", 25);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
          const firedAtMs = (yield* record(h.store)).lastCheckIn!.firedAtMs;
          assert.isAtLeast(
            firedAtMs,
            lastActivityAtMs + 15 * MINUTE,
            "never before the idle threshold has actually elapsed",
          );
          assert.isBelow(firedAtMs, lastActivityAtMs + 20 * MINUTE, "and not much after it");
        }),
      );
    }).pipe(scoped),
  );

  // --- 129, 130, 130b: restarts ---------------------------------------------

  it.effect("129: a restart mid-loop keeps the budget, deadline, strikes and armedAtMs", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { armedAtMs: 1_000, deadlineAtMs: 8 * HOUR, maxCheckIns: 6 });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          for (let n = 1; n <= 2; n++) {
            yield* advanceUntil(turnStartsAtLeast(h.dispatched, n), `check-in ${n}`, 60);
            const current = yield* record(h.store);
            yield* Ref.set(
              h.shellRef,
              threadShell({ updatedAt: msToIso(current.lastCheckIn!.firedAtMs + 3 * MINUTE) }),
            );
          }
        }),
      );

      // Kill and rebuild from disk, exactly as a server restart does.
      const rebuilt = yield* makeLoopStore(h.statePath);
      const after = yield* rebuilt.getThread(LOOP_THREAD_ID);
      assert.isTrue(after.armed);
      assert.strictEqual(after.checkInsUsed, 2, "the loop continues from check-in 3");
      assert.strictEqual(after.maxCheckIns, 6);
      assert.strictEqual(after.deadlineAtMs, 8 * HOUR);
      assert.strictEqual(after.armedAtMs, 1_000);
      assert.strictEqual(after.strikes, 0);
      assert.strictEqual(after.checkIns.length, 2, "and the ledger survives with it");
    }).pipe(scoped),
  );

  it.effect("130: a reboot storm does not fire three long-idle threads at once", () =>
    Effect.gen(function* () {
      const day = msToIso(-24 * HOUR);
      const two = threadShell({ id: "thread-2", updatedAt: day });
      const three = threadShell({ id: "thread-3", updatedAt: day });
      const h = yield* harness({
        shell: threadShell({ updatedAt: day }),
        extraShells: [two, three],
      });
      yield* arm(h.store);
      yield* arm(h.store, { threadId: "thread-2" });
      yield* arm(h.store, { threadId: "thread-3" });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          // The first tick after a restart: every one of these looks a day idle on the
          // projection, and without the boot-grace floor all three would fire together.
          yield* advancePolls(1);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);

          // They stay quiet right up to the threshold measured from process start.
          yield* advancePolls(13);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("130b: upstream's restart continuation window is not mistaken for idleness", () =>
    Effect.gen(function* () {
      // `5b7d72aad` (#9167) re-establishes a binding after a self-update and dispatches
      // `session.status: "starting", activeTurnId: null` synchronously at startup, while the
      // actual `sendTurn` waits on server activation. A continued thread therefore looks idle
      // with no error for a real window. Two mechanisms cover it and NEITHER was added for
      // this: `busyTurn` counts `"starting"`, so the fuse is the 45-minute one; and
      // `processStartedAtMs` floors the idle clock at process start.
      const h = yield* harness({
        shell: threadShell({
          updatedAt: msToIso(-2 * HOUR),
          sessionStatus: "starting",
          latestTurnState: null,
        }),
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(40);
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "a continued thread must not be nudged inside its activation window",
          );
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 0, "and spends nothing");

          // The premise the whole feature rests on, asserted rather than assumed: a thread
          // waiting on a scheduled wake has no live turn, so upstream never marks it for
          // continuation. The durability gap is untouched, and T3's record is the only trace.
          yield* Ref.set(
            h.shellRef,
            threadShell({ updatedAt: msToIso(0), sessionStatus: "ready", latestTurnState: null }),
          );
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the covered thread", 60);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 131, 132: not fighting auto-resume -----------------------------------

  it.effect("131: a usage limit holds the loop, which spends no budget waiting", () =>
    Effect.gen(function* () {
      // Auto-resume is off for this thread, so a limit produces no pending resume and guard 9
      // passes. Without the rate-limit fiber the loop would nudge straight into a live limit.
      const h = yield* harness({
        shell: threadShell(),
        events: [rateLimitEvent({ status: "rejected", resetsAtSeconds: 3 * 3_600 })],
        autoResumePending: false,
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.rateLimitedUntilMs > 0)),
            "the hold",
            5,
          );
          yield* advancePolls(60);
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "no nudge into a live limit",
          );
          const held = yield* record(h.store);
          assert.strictEqual(held.checkInsUsed, 0, "held is not spent");
          assert.strictEqual(held.rateLimitedUntilMs, 3 * HOUR);

          // Held ≠ stalled: once the window reopens the run carries on with a full budget.
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the resumed check-in", 240);
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("132: a pending auto-resume stands the loop down and is left intact", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell(), autoResumePending: true });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(60);
          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "two reactors must never both nudge one thread",
          );
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 0);

          // Nothing the loop did touched auto-resume's arm; when it clears, the loop resumes.
          yield* Ref.set(h.autoResumePending, false);
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the check-in", 30);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 133, 134: the two question channels ----------------------------------

  it.effect("133: a blocking question overnight parks the loop and spends nothing", () =>
    Effect.gen(function* () {
      // `AskUserQuestion` at 01:00. Guard 8 skips: nudging past a pending input is worse than
      // waiting, and the console keeps a blocking-since reading either way.
      const h = yield* harness({ shell: threadShell({ hasPendingUserInput: true }) });
      yield* arm(h.store, { deadlineAtMs: 3 * HOUR });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(90);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          const parked = yield* record(h.store);
          assert.strictEqual(parked.checkInsUsed, 0, "a parked loop spends nothing");
          assert.isTrue(parked.armed);
          const skips = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.skipped);
          assert.strictEqual(skips.length, 1, "one blocking-since note, not ninety");
          assert.strictEqual(
            (skips[0]!.payload as { reason: string }).reason,
            "pending_user_input",
          );

          // It runs out its deadline as `spent`, never `stalled`: nothing was tried and
          // failed, the loop simply never got a turn.
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the deadline",
            120,
          );
          assert.strictEqual((yield* record(h.store)).stopped?.reason, "spent");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("134: a deferred blocker does not park the loop, and its answer is delivered", () =>
    Effect.gen(function* () {
      // The other half of the channel split: `raise_blocker` records a question WITHOUT
      // blocking the turn, so the loop keeps firing, and the answer rides the next prompt.
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* h.store.addBlocker(LOOP_THREAD_ID, {
        id: "blocker-1",
        raisedAtMs: 60 * MINUTE,
        question: "Should I bump the major version?",
        options: [],
        context: null,
        answeredAtMs: null,
        answer: null,
        deliveredToAgent: false,
      });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the first check-in", 30);
          const first = turnStarts(yield* Ref.get(h.dispatched))[0]!;
          assert.notInclude(
            first.message.text,
            "Should I bump the major version?",
            "an unanswered blocker carries nothing to say",
          );

          // The human answers at 09:04 while the thread is idle.
          yield* h.store.answerBlocker(LOOP_THREAD_ID, "blocker-1", "yes, go to 2.0", 70 * MINUTE);
          const current = yield* record(h.store);
          yield* Ref.set(
            h.shellRef,
            threadShell({ updatedAt: msToIso(current.lastCheckIn!.firedAtMs + 3 * MINUTE) }),
          );

          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 2), "the second check-in", 60);
          const second = turnStarts(yield* Ref.get(h.dispatched))[1]!;
          assert.include(second.message.text, "Should I bump the major version?");
          assert.include(second.message.text, "yes, go to 2.0");
          yield* settleQuiet;
          assert.deepStrictEqual(
            yield* h.store.listUndeliveredAnswers(LOOP_THREAD_ID),
            [],
            "and it is marked delivered exactly once it has actually been said",
          );
        }),
      );
    }).pipe(scoped),
  );

  // --- 135: the empty console -----------------------------------------------

  it.effect("135: a run that ends spent with no blockers still reports why, and the budget", () =>
    Effect.gen(function* () {
      // The console degrades to useful, not to silence: a model that never raised a blocker
      // must still leave a stop reason and a budget behind.
      const h = yield* harness({ shell: threadShell({ sessionStatus: "running" }) });
      yield* arm(h.store, { deadlineAtMs: 10 * MINUTE, maxCheckIns: 4 });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the spent terminal",
            30,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.stopped?.reason, "spent");
          assert.isNotEmpty(after.stopped?.detail ?? "", "with a reason a human can read");
          assert.strictEqual(after.maxCheckIns, 4, "and the budget it was given");
          assert.deepStrictEqual([...after.blockers], []);
          const notes = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.stopped);
          assert.strictEqual(notes.length, 1);
          const payload = notes[0]!.payload as { reason: string; of: number; checkInsUsed: number };
          assert.strictEqual(payload.reason, "spent");
          assert.strictEqual(payload.of, 4);
          assert.strictEqual(payload.checkInsUsed, 0);
        }),
      );
    }).pipe(scoped),
  );

  // --- 136: takeover ---------------------------------------------------------

  it.effect("136: a human takeover at 04:00 disarms, and re-arming restores a full budget", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { maxCheckIns: 6 });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the first check-in", 30);
          const fired = yield* record(h.store);
          yield* Ref.set(
            h.shellRef,
            threadShell({
              latestUserMessageAt: msToIso(Date.parse(fired.lastCheckIn!.createdAtIso) + 1_000),
            }),
          );
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the handback",
            40,
          );
          const handedBack = yield* record(h.store);
          assert.strictEqual(handedBack.stopped?.reason, "handed-back");
          assert.strictEqual(handedBack.checkInsUsed, 1, "takeover is not a budget reset");

          // One tap to re-arm: a fresh run, not a repair of the old one.
          yield* h.store.arm({
            threadId: LOOP_THREAD_ID,
            armedAtMs: 5 * HOUR,
            deadlineAtMs: 12 * HOUR,
            maxCheckIns: 6,
          });
          const rearmed = yield* record(h.store);
          assert.isNull(rearmed.stopped, "the terminal clears only on a human re-arm");
          assert.strictEqual(rearmed.checkInsUsed, 0, "with a full budget");
          assert.strictEqual(rearmed.strikes, 0);
          assert.deepStrictEqual([...rearmed.checkIns], []);
        }),
      );
    }).pipe(scoped),
  );

  // --- 137: the done-file ----------------------------------------------------

  it.effect("137: the done-file at check-in 3 ends the run as done, with budget unspent", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { maxCheckIns: 6 });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          for (let n = 1; n <= 3; n++) {
            yield* advanceUntil(turnStartsAtLeast(h.dispatched, n), `check-in ${n}`, 80);
            const current = yield* record(h.store);
            yield* Ref.set(
              h.shellRef,
              threadShell({ updatedAt: msToIso(current.lastCheckIn!.firedAtMs + 3 * MINUTE) }),
            );
          }
          // The agent writes the file after its third check-in. T3 only ever stats it.
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          yield* writeSentinel(h.workspaceRoot, now);

          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the done terminal",
            40,
          );
          yield* settleQuiet;
          const after = yield* record(h.store);
          assert.strictEqual(after.stopped?.reason, "done");
          assert.notStrictEqual(after.stopped?.reason, "spent", "done is never reported as spent");
          assert.strictEqual(after.checkInsUsed, 3, "three check-ins left unused");
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 3);
          assert.deepStrictEqual(
            yield* Ref.get(h.stopSessions),
            [],
            "a finished agent's session is not killed under it",
          );
        }),
      );
    }).pipe(scoped),
  );
});
