/**
 * The loop supervisor's fibers, end to end. TESTS.md cases 87–107.
 *
 * Real reactor, real store, real decision table, real sentinel reads; a scripted projection
 * and a recording engine. Everything here runs on `TestClock`, so an eight-hour overnight
 * run costs milliseconds and no assertion depends on a timeout.
 *
 * Timing vocabulary used throughout, from the shipped defaults: the tick polls every
 * **60 s**, the idle threshold is **15 min**, the busy threshold is **45 min**, and guard
 * 11's floor between check-ins is **15 min**. `TestClock` starts at epoch 0, so a thread
 * whose `updatedAt` is `msToIso(0)` is exactly `now` milliseconds idle and fires on the 15th
 * tick.
 *
 * @module coil/loop/Reactor.test
 */

// @effect-diagnostics nodeBuiltinImport:off -- the persistence assertions read the state file
// directly, which is the point: they check what survived a process, not what a Ref remembers.
import * as NodeFSP from "node:fs/promises";

import type { OrchestrationCommand } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { loopHooksFor } from "./crons.ts";
import { LOOP_ACTIVITY_KINDS, LoopReactorLive } from "./Reactor.ts";
import {
  activitiesOfKind,
  advancePolls,
  advanceUntil,
  clearLoopEnv,
  commandTypes,
  harness,
  HOUR,
  isStopped,
  LOOP_THREAD_ID,
  MINUTE,
  msToIso,
  rateLimitEvent,
  settleQuiet,
  threadShell,
  turnStarts,
  turnStartsAtLeast,
  userInputRequestedEvent,
  writeSentinel,
} from "./reactorHarness.ts";
import { LoopState, LoopStore, type LoopStoreShape } from "./state.ts";

clearLoopEnv();

/** Hoisted: both the schema literal and the compiled decoder would otherwise be rebuilt. */
const decodeLoopState = Schema.decodeUnknownEffect(Schema.fromJsonString(LoopState));

/** The default armed run: six check-ins, eight hours, master toggle on. */
const arm = (
  store: LoopStoreShape,
  o: {
    readonly threadId?: string;
    readonly maxCheckIns?: number;
    readonly deadlineAtMs?: number;
    readonly armedAtMs?: number;
    readonly pinnedByLoop?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    yield* store.setGlobal({ enabled: true });
    yield* store.arm({
      threadId: o.threadId ?? LOOP_THREAD_ID,
      armedAtMs: o.armedAtMs ?? 0,
      deadlineAtMs: o.deadlineAtMs ?? 8 * HOUR,
      maxCheckIns: o.maxCheckIns ?? 6,
      ...(o.pinnedByLoop === undefined ? {} : { pinnedByLoop: o.pinnedByLoop }),
    });
  });

/** A recurring wake scheduled past the deadline: pending for the bound, not deferred to. */
const recurringCronPastDeadline = (store: LoopStoreShape, deadlineAtMs: number) =>
  store.setCrons(LOOP_THREAD_ID, {
    recordedAtMs: 0,
    entries: [
      {
        id: "cron-1",
        schedule: "*/20 * * * *",
        recurring: true,
        prompt: "keep going",
        nextFireAtMs: deadlineAtMs + HOUR,
      },
    ],
  });

/** Boot the real reactor over the harness doubles for the duration of `body`. */
const withReactor = <ROut, LE, A, E, R>(
  deps: Layer.Layer<ROut, LE, never>,
  body: Effect.Effect<A, E, R>,
) => body.pipe(Effect.provide(LoopReactorLive.pipe(Layer.provideMerge(deps))));

/** Everything the harness itself needs: a scope for the temp dir, real fs, and TestClock. */
type OuterR = Scope.Scope | FileSystem.FileSystem | Path.Path;

const scoped = <A, E>(body: Effect.Effect<A, E, OuterR>) =>
  body.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer())));

const record = (store: LoopStoreShape, threadId: string = LOOP_THREAD_ID) =>
  store.getThread(threadId);

describe("LoopReactor — the fibers", () => {
  // --- 87, 88: the cost floor ------------------------------------------------

  it.effect("87: COIL_LOOP_ENABLED=0 forks no fiber at all", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      process.env.COIL_LOOP_ENABLED = "0";
      try {
        yield* withReactor(
          h.deps,
          Effect.gen(function* () {
            // Three simulated hours past every threshold this thread has.
            yield* advancePolls(180);
            assert.strictEqual(
              yield* Ref.get(h.shellCalls),
              0,
              "a disabled reactor must not read the projection",
            );
            assert.deepStrictEqual(yield* Ref.get(h.dispatched), []);
            assert.strictEqual((yield* record(h.store)).checkInsUsed, 0);
          }),
        );
      } finally {
        delete process.env.COIL_LOOP_ENABLED;
      }
    }).pipe(scoped),
  );

  it.effect("88: nothing armed issues zero projection queries per tick", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* h.store.setGlobal({ enabled: true });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(30);
          assert.strictEqual(yield* Ref.get(h.shellCalls), 0, "no thread shell reads");
          assert.strictEqual(yield* Ref.get(h.projectCalls), 0, "no project shell reads");
        }),
      );
    }).pipe(scoped),
  );

  // --- 89–92: the nudge itself ----------------------------------------------

  it.effect("89/91/92: one armed idle thread fires exactly one correctly-shaped turn", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        shell: threadShell({ runtimeMode: "read-only", interactionMode: "plan" }),
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the first check-in");
          const starts = turnStarts(yield* Ref.get(h.dispatched));
          assert.strictEqual(starts.length, 1);
          const turn = starts[0]!;
          // 91 — both ids carry the prefix, so a loop turn is identifiable in the event log.
          assert.isTrue(turn.commandId.startsWith("coil-loop:"), turn.commandId);
          assert.isTrue(turn.message.messageId.startsWith("coil-loop:"), turn.message.messageId);
          // 92 — copied from the shell, never defaulted. A loop turn that silently promoted a
          // read-only thread to full access would be a security regression.
          assert.strictEqual(turn.runtimeMode, "read-only");
          assert.strictEqual(turn.interactionMode, "plan");
          assert.strictEqual(turn.threadId, LOOP_THREAD_ID);
          assert.include(turn.message.text, "Loop check-in 1 of 6.");
          assert.isFalse(turn.message.text.startsWith("/"), "never readable as a slash command");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("90: a second tick while still idle does not fire again (guard 11's floor)", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the first check-in");
          yield* advancePolls(2);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 93, 94: reserve before dispatch --------------------------------------

  it.effect("93: a dispatch that fails still consumes the reservation, and does not retry", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* Ref.set(h.failCommandTypes, new Set(["thread.turn.start"]));
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.checkInsUsed === 1)),
            "the reservation",
          );
          assert.notInclude(commandTypes(yield* Ref.get(h.dispatched)), "thread.turn.start");
          // The floor holds even though nothing was sent: a provider that cannot spawn burns
          // budget rather than tight-looping.
          yield* advancePolls(3);
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("93b: a provider that can never spawn is bounded by attempts, not by the night", () =>
    Effect.gen(function* () {
      // The design prices this path at "6 attempts, not 480 a night". In practice strikes
      // bound it tighter: a dispatch that never lands never moves `updatedAt`, so two
      // consecutive check-ins are judged unproductive and the run reports `stalled` at two.
      // Both bounds are real; what matters is that neither is unbounded.
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { maxCheckIns: 6, deadlineAtMs: 8 * HOUR });
      yield* Ref.set(h.failCommandTypes, new Set(["thread.turn.start"]));
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the run to end itself",
            400,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.checkInsUsed, 2, "two attempts, not four hundred and eighty");
          assert.isAtMost(after.checkInsUsed, after.maxCheckIns);
          assert.strictEqual(after.stopped?.reason, "stalled");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("93c: a responsive thread spends its whole budget and then reports spent", () =>
    Effect.gen(function* () {
      // The budget bound on its own, with the strike bound held off: after each check-in the
      // thread is scripted to move (three minutes, past `productiveMs`) and then go quiet
      // again, which is what a working agent looks like.
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { maxCheckIns: 6, deadlineAtMs: 8 * HOUR });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          for (let n = 1; n <= 6; n++) {
            // Wait for the TURN, not the reservation. Moving the shell in between would land
            // inside the pre-dispatch re-read and the check-in would abort — which is the
            // wake race working, and would have made this test measure the wrong thing.
            yield* advanceUntil(turnStartsAtLeast(h.dispatched, n), `check-in ${n}`, 60);
            const current = yield* record(h.store);
            yield* Ref.set(
              h.shellRef,
              threadShell({ updatedAt: msToIso(current.lastCheckIn!.firedAtMs + 3 * MINUTE) }),
            );
          }
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "budget exhaustion",
            60,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.checkInsUsed, 6, "exactly the budget, not one more");
          assert.strictEqual(after.stopped?.reason, "spent");
          assert.strictEqual(after.strikes, 0, "a moving thread never accrues a strike");
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 6);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("94: a defect thrown dispatching does not kill the tick fiber", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* Ref.set(h.dieOnCommandType, "thread.turn.start");
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.checkInsUsed === 1)),
            "the first (defecting) attempt",
          );
          yield* Ref.set(h.dieOnCommandType, null);
          yield* advanceUntil(
            turnStartsAtLeast(h.dispatched, 1),
            "a later check-in after the defect",
          );
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("94b: a defect on one thread does not stop the others in the same pass", () =>
    Effect.gen(function* () {
      const other = threadShell({ id: "thread-2" });
      const h = yield* harness({ shell: threadShell(), extraShells: [other] });
      yield* arm(h.store);
      yield* arm(h.store, { threadId: "thread-2" });
      yield* Ref.set(h.dieOnThreadId, LOOP_THREAD_ID);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "thread-2's check-in");
          const starts = turnStarts(yield* Ref.get(h.dispatched));
          assert.deepStrictEqual(
            starts.map((t) => t.threadId),
            ["thread-2"],
            "the healthy thread is nudged even though its neighbour defected",
          );
          // Both spent their reservation; only one produced a turn.
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1);
          assert.strictEqual((yield* record(h.store, "thread-2")).checkInsUsed, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 95: the wake race ----------------------------------------------------

  it.effect("95: a thread that blocks between the guard block and dispatch is not nudged", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          // Stop one tick short of the 15-minute threshold, then arm the swap for the NEXT
          // read — the guard block sees an idle thread, the pre-dispatch re-read sees a
          // thread now waiting on a human.
          yield* advancePolls(14);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          const readsSoFar = yield* Ref.get(h.shellCalls);
          yield* Ref.set(h.shellOverrideRef, {
            afterCall: readsSoFar + 1,
            shell: threadShell({ hasPendingUserInput: true }),
          });
          const abortNoted = Ref.get(h.dispatched).pipe(
            Effect.map((all) =>
              activitiesOfKind(all, LOOP_ACTIVITY_KINDS.skipped).some(
                (a) => (a.payload as { reason?: string }).reason === "aborted_pre_dispatch",
              ),
            ),
          );
          // A tight bound, with a little margin for pump scheduling under load: the abort
          // must land within a few polls, not eventually.
          yield* advanceUntil(abortNoted, "the aborted attempt", 6);

          assert.strictEqual(
            turnStarts(yield* Ref.get(h.dispatched)).length,
            0,
            "the nudge must not be sent",
          );
          const aborted = activitiesOfKind(
            yield* Ref.get(h.dispatched),
            LOOP_ACTIVITY_KINDS.skipped,
          ).filter((a) => (a.payload as { reason?: string }).reason === "aborted_pre_dispatch");
          assert.strictEqual(aborted.length, 1, "the aborted attempt is recorded");
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1, "the reservation stands");
        }),
      );
    }).pipe(scoped),
  );

  // --- 96–98: the keep-active pin -------------------------------------------

  it.effect("96: settledOverride 'active' is repaired with thread.unsettle after the turn", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell({ settledOverride: "active" }) });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.dispatched).pipe(
              Effect.map((all) => commandTypes(all).includes("thread.unsettle")),
            ),
            "the pin repair",
          );
          const types = commandTypes(yield* Ref.get(h.dispatched));
          assert.include(types, "thread.unsettle");
          assert.isAbove(
            types.indexOf("thread.unsettle"),
            types.indexOf("thread.turn.start"),
            "the repair follows the turn; issuing it first would be cleared by the decider",
          );
          const unsettle = (yield* Ref.get(h.dispatched)).find(
            (c): c is Extract<OrchestrationCommand, { type: "thread.unsettle" }> =>
              c.type === "thread.unsettle",
          );
          assert.strictEqual(unsettle?.reason, "user");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("97: no pin, no repair — the reactor can never create one", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell({ settledOverride: null }) });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the check-in");
          yield* settleQuiet;
          assert.notInclude(commandTypes(yield* Ref.get(h.dispatched)), "thread.unsettle");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("98: a failed pin repair is never silent — it posts an error-tone breadcrumb", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell({ settledOverride: "active" }) });
      yield* arm(h.store);
      yield* Ref.set(h.failCommandTypes, new Set(["thread.unsettle"]));
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.dispatched).pipe(
              Effect.map(
                (all) => activitiesOfKind(all, LOOP_ACTIVITY_KINDS.pinRepairFailed).length > 0,
              ),
            ),
            "the pin-repair breadcrumb",
          );
          const notes = activitiesOfKind(
            yield* Ref.get(h.dispatched),
            LOOP_ACTIVITY_KINDS.pinRepairFailed,
          );
          assert.strictEqual(notes.length, 1);
          assert.strictEqual(notes[0]!.tone, "error");
          // The check-in itself still landed: the repair is a follow-up, not a precondition.
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 99: the bound actually stops the agent -------------------------------

  it.effect("99: budget exhaustion writes spent once, stops the session, then no-ops", () =>
    Effect.gen(function* () {
      const deadlineAtMs = 8 * HOUR;
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { maxCheckIns: 1, deadlineAtMs });
      yield* recurringCronPastDeadline(h.store, deadlineAtMs);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.stopSessions).pipe(Effect.map((all) => all.length > 0)),
            "the spent terminal and its session stop",
            120,
          );
          const stopped = (yield* record(h.store)).stopped;
          assert.strictEqual(stopped?.reason, "spent");
          assert.strictEqual(
            (yield* Ref.get(h.stopSessions)).length,
            1,
            "recorded crons are still pending, so the session must be ended",
          );

          const before = activitiesOfKind(
            yield* Ref.get(h.dispatched),
            LOOP_ACTIVITY_KINDS.stopped,
          );
          assert.strictEqual(before.length, 1);
          // `spent` is never reported as `done`.
          assert.strictEqual((before[0]!.payload as { reason: string }).reason, "spent");
          assert.notStrictEqual((before[0]!.payload as { reason: string }).reason, "done");

          yield* advancePolls(20);
          assert.strictEqual(
            activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.stopped).length,
            1,
            "the terminal is sticky and written exactly once",
          );
          assert.strictEqual((yield* Ref.get(h.stopSessions)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("99b: a passed deadline stops the run while the thread is busy", () =>
    Effect.gen(function* () {
      // `running` selects the 45-minute fuse, so this thread never reaches an idle guard.
      // With the stop sweep at 4b it is still stopped at its deadline; at the old position
      // (guard 13) it would have walked through it indefinitely.
      const h = yield* harness({
        shell: threadShell({ sessionStatus: "running", latestTurnState: "running" }),
      });
      yield* arm(h.store, { deadlineAtMs: 5 * MINUTE });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the deadline stop",
            30,
          );
          const stopped = (yield* record(h.store)).stopped;
          assert.strictEqual(stopped?.reason, "spent");
          assert.include(stopped?.detail ?? "", "deadline");
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
        }),
      );
    }).pipe(scoped),
  );

  // --- 100–102: the rate-limit tap ------------------------------------------

  it.effect("100: a rejected verdict writes rateLimitedUntilMs durably", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        shell: threadShell(),
        events: [rateLimitEvent({ status: "rejected", resetsAtSeconds: 3_600 })],
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.rateLimitedUntilMs > 0)),
            "the rate-limit hold",
            5,
          );
          assert.strictEqual((yield* record(h.store)).rateLimitedUntilMs, 3_600_000);
          // Durable: a five-hour limit outlives the process that observed it.
          const persisted = yield* Effect.promise(() => NodeFSP.readFile(h.statePath, "utf8"));
          assert.include(persisted, '"rateLimitedUntilMs":3600000');
        }),
      );
    }).pipe(scoped),
  );

  it.effect("101: a non-rejected verdict writes nothing", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        shell: threadShell(),
        events: [rateLimitEvent({ status: "allowed_warning", resetsAtSeconds: 3_600 })],
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(3);
          assert.strictEqual((yield* record(h.store)).rateLimitedUntilMs, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("102: two subscribers on one stream — neither consumes the other's events", () =>
    Effect.gen(function* () {
      // The rate-limit tap and the user-input recorder each subscribe to `streamEvents`
      // independently. If the reactor shared one subscription, one of these two records
      // would be missing. (Upstream's PubSub semantics are upstream's contract; what this
      // pins is that the fork forks two subscriptions rather than one.)
      const h = yield* harness({
        shell: threadShell(),
        events: [
          rateLimitEvent({ status: "rejected", resetsAtSeconds: 3_600 }),
          userInputRequestedEvent({ requestId: "req-1", question: "which branch?" }),
        ],
      });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(
              Effect.map((r) => r.rateLimitedUntilMs > 0 && r.userInputs.length > 0),
            ),
            "both subscribers to record",
            5,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.rateLimitedUntilMs, 3_600_000);
          assert.strictEqual(after.userInputs[0]?.requestId, "req-1");
        }),
      );
    }).pipe(scoped),
  );

  // --- 103, 104: boot grace -------------------------------------------------

  it.effect("103: a long-idle thread does not fire on the first post-restart tick", () =>
    Effect.gen(function* () {
      // A day of idleness on the projection clock. `processStartedAtMs` floors it, so the
      // reactor sees one minute of idleness, not twenty-four hours.
      const h = yield* harness({ shell: threadShell({ updatedAt: msToIso(-24 * HOUR) }) });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(1);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("104: it fires once the idle threshold has passed since process start", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell({ updatedAt: msToIso(-24 * HOUR) }) });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(14);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0, "not yet");
          // A tight bound: it must fire within a few polls of the threshold, not eventually.
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the check-in", 6);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 105, 106: breadcrumbs ------------------------------------------------

  it.effect("105: a skip repeated across ten ticks appends one activity, not ten", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* h.store.setRateLimitedUntil(LOOP_THREAD_ID, 8 * HOUR);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(10);
          const skips = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.skipped);
          assert.strictEqual(
            skips.length,
            1,
            "an activity per tick would bump updatedAt and reset the reactor's own idle clock",
          );
          assert.strictEqual((skips[0]!.payload as { reason: string }).reason, "rate_limited");
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 0, "a skip spends nothing");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("106: a breadcrumb failure does not abort the check-in", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* Ref.set(h.failCommandTypes, new Set(["thread.activity.append"]));
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the check-in");
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 1);
          assert.strictEqual(
            activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.checkedIn).length,
            0,
            "the note really did fail",
          );
          assert.strictEqual((yield* record(h.store)).checkInsUsed, 1);
        }),
      );
    }).pipe(scoped),
  );

  // --- 107: shutdown --------------------------------------------------------

  it.effect("107: interrupting the fibers leaves the persisted record consistent", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* Effect.scoped(
        withReactor(
          h.deps,
          // Advance to the firing tick and tear the scope down without waiting for quiet, so
          // the interruption lands at an arbitrary point in the decision.
          Effect.gen(function* () {
            yield* advancePolls(14);
            yield* TestClock.adjust(60_000);
          }),
        ),
      );

      const persisted = yield* Effect.promise(() => NodeFSP.readFile(h.statePath, "utf8"));
      // Decoded with the real schema, not `JSON.parse`: a file that no longer decodes is the
      // failure mode that collapses to EMPTY_STATE and silently disarms every loop.
      const parsed = yield* decodeLoopState(persisted);
      const row = parsed.threads[LOOP_THREAD_ID]!;
      assert.isAtMost(row.checkInsUsed, 1, "never more reservations than ticks");
      // The invariant that matters: a reservation is never half-written. If the counter moved
      // the ledger moved with it, because both live in one atomic file rewrite.
      if (row.checkInsUsed === 1) {
        assert.isNotNull(row.lastCheckIn);
        assert.strictEqual(row.checkIns.length, 1);
      }
    }).pipe(scoped),
  );

  // --- the master toggle, and the reverse states -----------------------------

  it.effect("toggle off: nothing fires, and nothing is disarmed or stopped", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* h.store.setGlobal({ enabled: false });
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(60);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          const after = yield* record(h.store);
          assert.isTrue(after.armed, "the toggle stands loops down; it disarms nothing");
          assert.isNull(after.stopped, "and it manufactures no terminal nobody chose");
          assert.strictEqual(after.checkInsUsed, 0, "budgets stay intact");
          const skips = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.skipped);
          assert.strictEqual(skips.length, 1);
          assert.strictEqual((skips[0]!.payload as { reason: string }).reason, "disabled");
        }),
      );
    }).pipe(scoped),
  );

  it.effect("takeover stops the loop as handed-back without refunding the budget", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(turnStartsAtLeast(h.dispatched, 1), "the first check-in");
          const afterFire = yield* record(h.store);
          assert.strictEqual(afterFire.checkInsUsed, 1);
          // A human message strictly after our own minted `createdAt`. Equal would be our own
          // nudge, and would disarm every loop on its own first check-in.
          yield* Ref.set(
            h.shellRef,
            threadShell({
              latestUserMessageAt: msToIso(Date.parse(afterFire.lastCheckIn!.createdAtIso) + 1_000),
            }),
          );
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the handback",
            40,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.stopped?.reason, "handed-back");
          assert.strictEqual(after.checkInsUsed, 1, "takeover is not a budget reset");
          assert.isFalse(after.armed);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("a deleted thread disarms, unpins what the loop pinned, and ends its session", () =>
    Effect.gen(function* () {
      const deadlineAtMs = 8 * HOUR;
      const h = yield* harness({ shell: null });
      yield* arm(h.store, { deadlineAtMs, pinnedByLoop: true });
      yield* recurringCronPastDeadline(h.store, deadlineAtMs);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.stopSessions).pipe(Effect.map((all) => all.length > 0)),
            "the disarm, unpin and session stop",
            10,
          );
          const after = yield* record(h.store);
          assert.isFalse(after.armed);
          assert.isNull(after.stopped, "a disarm is not a terminal state");
          assert.strictEqual(after.checkInsUsed, 0);
          assert.isFalse(after.pinnedByLoop, "the pin the loop created is removed");
          assert.include(commandTypes(yield* Ref.get(h.dispatched)), "thread.unpin");
          assert.deepStrictEqual(
            yield* Ref.get(h.stopSessions),
            [LOOP_THREAD_ID],
            "wakes are still recorded, and nothing left will ever bound them",
          );
        }),
      );
    }).pipe(scoped),
  );

  it.effect("a projection read failure skips the tick rather than disarming the loop", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* Ref.set(h.shellReadFails, true);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(20);
          const after = yield* record(h.store);
          assert.isTrue(after.armed, "a transient SQL error is not a deleted thread");
          assert.isNull(after.stopped);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect(
    "a projection failure on the pre-dispatch re-read is not reported as a missing thread",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ shell: threadShell() });
        yield* arm(h.store);
        // One strike already on the record, so "did this abort add one?" is answerable.
        yield* h.store.update(LOOP_THREAD_ID, (current) => ({ ...current, strikes: 1 }));
        yield* withReactor(
          h.deps,
          Effect.gen(function* () {
            yield* advancePolls(14);
            const readsSoFar = yield* Ref.get(h.shellCalls);
            // The guard block's read succeeds; the pre-dispatch re-read fails.
            yield* Ref.set(h.shellFailsAfterCall, readsSoFar + 1);
            const abortNoted = Ref.get(h.dispatched).pipe(
              Effect.map((all) =>
                activitiesOfKind(all, LOOP_ACTIVITY_KINDS.skipped).some(
                  (a) => (a.payload as { reason?: string }).reason === "aborted_pre_dispatch",
                ),
              ),
            );
            yield* advanceUntil(abortNoted, "the aborted attempt", 6);

            const abort = activitiesOfKind(
              yield* Ref.get(h.dispatched),
              LOOP_ACTIVITY_KINDS.skipped,
            ).find((a) => (a.payload as { reason?: string }).reason === "aborted_pre_dispatch");
            assert.strictEqual(
              (abort!.payload as { verdict: string }).verdict,
              "projection_unavailable",
              "a projection that did not answer is not a thread that is gone",
            );
            assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
            const after = yield* record(h.store);
            assert.isTrue(after.armed, "a hiccup never disarms");
            assert.isNull(after.stopped);
            assert.strictEqual(
              after.strikes,
              1,
              "nothing was sent, so nothing about the agent was demonstrated",
            );
          }),
        );
      }).pipe(scoped),
  );

  it.effect("a takeover seen by the pre-dispatch re-read is recorded on that same tick", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(14);
          const readsSoFar = yield* Ref.get(h.shellCalls);
          yield* Ref.set(h.shellOverrideRef, {
            afterCall: readsSoFar + 1,
            // Typed while the tick was mid-flight: later than any `createdAt` this nudge
            // could carry, so the compare reads it as a takeover rather than as our own turn.
            shell: threadShell({ latestUserMessageAt: msToIso(HOUR) }),
          });
          yield* advanceUntil(isStopped(h.store), "the handback terminal", 6);

          const after = yield* record(h.store);
          assert.strictEqual(
            after.stopped?.reason,
            "handed-back",
            "the console must not keep saying 'watching' about a run that is already over",
          );
          assert.isFalse(after.armed);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0, "no nudge");
          assert.strictEqual(
            activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.stopped).length,
            1,
          );
        }),
      );
    }).pipe(scoped),
  );

  it.effect("a stop request banked by the console is serviced exactly once", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      // Exactly what `POST /api/coil/loop` leaves behind on a disarm with pending wakes: a
      // stopped record, nothing armed, and one banked request.
      yield* arm(h.store);
      yield* h.store.stop(LOOP_THREAD_ID, {
        reason: "handed-back",
        atMs: MINUTE,
        detail: "disarmed from the console",
      });
      yield* h.store.requestSessionStop(LOOP_THREAD_ID, MINUTE);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.stopSessions).pipe(Effect.map((all) => all.length > 0)),
            "the banked stop",
            6,
          );
          // Ten more polls: the request is cleared, so it cannot re-fire every minute for the
          // rest of the night.
          yield* advancePolls(10);
          assert.deepStrictEqual(yield* Ref.get(h.stopSessions), [LOOP_THREAD_ID]);
          assert.strictEqual((yield* record(h.store)).stopRequestedAtMs, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("the done-file ends the run as done, with budget left over", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store);
      // Written after arming, so it is a signal rather than a leftover.
      yield* writeSentinel(h.workspaceRoot, 5 * MINUTE);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            record(h.store).pipe(Effect.map((r) => r.stopped !== null)),
            "the done terminal",
            30,
          );
          yield* settleQuiet;
          const after = yield* record(h.store);
          assert.strictEqual(after.stopped?.reason, "done");
          assert.strictEqual(after.checkInsUsed, 0, "done costs no check-ins");
          assert.deepStrictEqual(
            yield* Ref.get(h.stopSessions),
            [],
            "done never kills the session — the agent said it finished",
          );
        }),
      );
    }).pipe(scoped),
  );

  it.effect("loop_done from the MCP toolkit ends the run as done and unpins", () =>
    Effect.gen(function* () {
      // The toolkit's whole contract with the supervisor is two fields on the record. It
      // never dispatches and never stops anything itself, so this is the only place the two
      // halves meet — and the file channel and the tool channel must be indistinguishable
      // once written, because `enableAgentBrowserAccess` off removes the tool entirely.
      const h = yield* harness({ shell: threadShell() });
      yield* arm(h.store, { pinnedByLoop: true });
      yield* h.store.update(LOOP_THREAD_ID, (current) => ({
        ...current,
        loopDoneAtMs: 5 * MINUTE,
        loopDoneReason: "shipped the migration and the tests are green",
      }));
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advanceUntil(
            Ref.get(h.dispatched).pipe(
              Effect.map((all) => activitiesOfKind(all, LOOP_ACTIVITY_KINDS.stopped).length > 0),
            ),
            "the done terminal",
            10,
          );
          const after = yield* record(h.store);
          assert.strictEqual(after.stopped?.reason, "done");
          assert.notStrictEqual(after.stopped?.reason, "spent", "done is never reported as spent");
          assert.strictEqual(after.checkInsUsed, 0, "loop_done costs no check-ins");
          assert.include(
            after.stopped?.detail ?? "",
            "shipped the migration",
            "the agent's own words survive onto the terminal",
          );

          const notes = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.stopped);
          assert.strictEqual(notes.length, 1);
          assert.strictEqual((notes[0]!.payload as { cause: string }).cause, "loop_done");

          assert.include(commandTypes(yield* Ref.get(h.dispatched)), "thread.unpin");
          assert.isFalse((yield* record(h.store)).pinnedByLoop);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
        }),
      );
    }).pipe(scoped),
  );

  it.effect("a pending auto-resume stands the loop down without spending budget", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell(), autoResumePending: true });
      yield* arm(h.store);
      yield* withReactor(
        h.deps,
        Effect.gen(function* () {
          yield* advancePolls(40);
          assert.strictEqual(turnStarts(yield* Ref.get(h.dispatched)).length, 0);
          const after = yield* record(h.store);
          assert.strictEqual(after.checkInsUsed, 0);
          assert.isTrue(after.armed);
          const skips = activitiesOfKind(yield* Ref.get(h.dispatched), LOOP_ACTIVITY_KINDS.skipped);
          assert.strictEqual(
            (skips[0]!.payload as { reason: string }).reason,
            "auto_resume_pending",
          );
        }),
      );
    }).pipe(scoped),
  );
});

/**
 * The seam the whole feature hangs off: the Claude adapter's hooks.
 *
 * `server.ts` composes the supervisor with `Layer.provide`, not `provideMerge` — so
 * `LoopStore` is discharged and does *not* reach the app context the adapter's fiber runs in.
 * Every other test in this file uses `provideMerge` for convenience, which is exactly the
 * shape that hid this: `Effect.serviceOption(LoopStore)` answered `Some` in the tests and
 * `None` in production, and the hooks were never installed on any real machine.
 */
describe("LoopReactor — installing the adapter's hooks", () => {
  it.effect("a server-shaped composition installs them, even with no LoopStore in context", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      // `Layer.provide`, exactly as `coil/index.ts` composes it. Nothing is re-exported.
      const serverShaped = LoopReactorLive.pipe(Layer.provide(h.deps));
      yield* Effect.provide(
        Effect.gen(function* () {
          assert.isTrue(
            Option.isNone(yield* Effect.serviceOption(LoopStore)),
            "this is the adapter's world: the store is genuinely not in context",
          );
          const hooks = yield* loopHooksFor(LOOP_THREAD_ID);
          assert.isDefined(hooks, "the adapter must still get its hooks");
          assert.deepStrictEqual(Object.keys(hooks!).sort(), [
            "PostToolUse",
            "Stop",
            "SubagentStop",
          ]);
        }),
        serverShaped,
      );
      // Outside the supervisor's scope there is nothing to record into, and the holder says so.
      assert.isUndefined(yield* loopHooksFor(LOOP_THREAD_ID));
    }).pipe(scoped),
  );

  it.effect("the kill switch still means no hooks at all", () =>
    Effect.gen(function* () {
      const h = yield* harness({ shell: threadShell() });
      process.env.COIL_LOOP_ENABLED = "0";
      try {
        yield* Effect.provide(
          Effect.map(loopHooksFor(LOOP_THREAD_ID), (hooks) => {
            assert.isUndefined(hooks);
          }),
          LoopReactorLive.pipe(Layer.provide(h.deps)),
        );
      } finally {
        delete process.env.COIL_LOOP_ENABLED;
      }
    }).pipe(scoped),
  );
});
