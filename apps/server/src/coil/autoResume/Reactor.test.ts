// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalErrorInEffectFailure:off -- the dispatch stub raises a bare
// Error on purpose, mirroring an arbitrary driver throw the reactor must survive.
import * as NodePath from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AutoResumeReactorLive } from "./Reactor.ts";
import {
  type AutoResumeReactorReceipt,
  AutoResumeReactorReceipts,
  AutoResumeReactorReceiptsLive,
} from "./receipts.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./state.ts";

// Defaults: safetyMargin 60s, pollMs 30s. With resetsAt=100s the resume is due at
// 100_000 + 60_000 = 160_000ms, so advancing past that (with 30s wake ticks) fires it.

// A Claude-thread read model, one row per id (one row unless a scenario asks for more).
// Cast because building every branded field is noise for this test — the reactor only reads
// the fields set here.
const readModel = (o: {
  /** Ids to build rows for, in order. Every row is otherwise identical. */
  threadIds?: ReadonlyArray<string>;
  messages?: Array<{ id: string; role: string }>;
  status?: string;
  latestTurnId?: string;
  /** Explicit latestTurn override; pass null to model an idle thread whose
   * projection row has no latest_turn_id (see radroid/t3code#6). `completedAt` is when
   * the turn ended — the guard uses it to tell a turn that outlived the closed window
   * from one that died inside it. TestClock starts at 0, so script it in test-clock ms. */
  latestTurn?: { turnId: string; state: string; completedAt?: string } | null;
}): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [{ id: "project-1", workspaceRoot: "/tmp/coil-nonexistent-workspace" }],
    threads: (o.threadIds ?? ["thread-1"]).map((id) => ({
      id,
      projectId: "project-1",
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: null,
      deletedAt: null,
      archivedAt: null,
      settledOverride: null,
      messages: o.messages ?? [{ id: "u1", role: "user" }],
      activities: [],
      latestTurn:
        o.latestTurn !== undefined
          ? o.latestTurn
          : { turnId: o.latestTurnId ?? "turn-1", state: "completed" },
      session: { status: o.status ?? "ready", providerName: "claudeAgent" },
    })),
  }) as unknown as OrchestrationReadModel;

const rejectedEvent = (
  resetsAtSeconds: number,
  threadId = "thread-1",
  eventId = "evt-1",
): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId,
    provider: "claudeAgent",
    threadId,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      rateLimits: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: resetsAtSeconds,
        },
      },
    },
  }) as unknown as ProviderRuntimeEvent;

// Real AutoResumeStore + real Reactor; stubbed engine/provider/snapshot; TestClock.
// Events are pre-loaded into the provider stream (emit-then-block) so delivery is
// deterministic and does not depend on publish/subscribe timing.
const harness = (initialModel: OrchestrationReadModel, events: ProviderRuntimeEvent[]) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<OrchestrationCommand[]>([]);
    const modelRef = yield* Ref.make(initialModel);
    const failTurnStart = yield* Ref.make(false);

    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-reactor-" });
    const statePath = NodePath.join(root, "state.json");

    const EngineStub = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if (command.type === "thread.turn.start" && (yield* Ref.get(failTurnStart))) {
            return yield* Effect.fail(new Error("simulated dispatch failure"));
          }
          yield* Ref.update(dispatched, (a) => [...a, command]);
          return { sequence: 0 };
        }),
      streamDomainEvents: Stream.empty,
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as typeof OrchestrationEngineService.Service);

    const snapshotCalls = yield* Ref.make(0);
    // One-shot: the NEXT snapshot read fails and the flag clears itself. `getSnapshot` has a
    // typed `ProjectionRepositoryError` channel in production; the shape of the error does
    // not matter here, only that the read fails where the reactor expects it can.
    const failNextSnapshot = yield* Ref.make(false);
    const SnapshotStub = Layer.succeed(ProjectionSnapshotQuery, {
      getSnapshot: () =>
        Effect.gen(function* () {
          yield* Ref.update(snapshotCalls, (n) => n + 1);
          if (yield* Ref.getAndSet(failNextSnapshot, false)) {
            return yield* Effect.fail(new Error("simulated snapshot read failure"));
          }
          return yield* Ref.get(modelRef);
        }),
    } as unknown as typeof ProjectionSnapshotQuery.Service);

    const ProviderStub = Layer.succeed(ProviderService, {
      get streamEvents() {
        return Stream.concat(Stream.fromIterable(events), Stream.never);
      },
    } as unknown as typeof ProviderService.Service);

    const store = yield* makeAutoResumeStore(statePath);
    const StoreLive = Layer.succeed(AutoResumeStore, store);

    // Crypto.make derives randomUUIDv4 from randomBytes; a counter keeps bytes distinct
    // so generated command/message ids differ across calls.
    let seed = 1;
    const CryptoStub = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => {
          const bytes = new Uint8Array(size);
          for (let i = 0; i < size; i++) bytes[i] = (seed + i) & 0xff;
          seed += size;
          return bytes;
        },
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    );

    const deps = Layer.mergeAll(
      EngineStub,
      SnapshotStub,
      ProviderStub,
      CryptoStub,
      StoreLive,
      // Test-only, and the whole reason the waits below are exact. Production never provides
      // it, so the reactor's emitter resolves to a no-op there. See `receipts.ts`.
      AutoResumeReactorReceiptsLive,
    );
    return { dispatched, modelRef, deps, store, snapshotCalls, failTurnStart, failNextSnapshot };
  });

const types = (commands: ReadonlyArray<OrchestrationCommand>) => commands.map((c) => c.type);

// --- waiting -----------------------------------------------------------------------
//
// Every wait below is an await on a receipt the reactor published (`receipts.ts`). Nothing
// here counts scheduler turns, and nothing here moves the clock except the polls a scenario
// asks for.
//
// It used to count turns: `advancePastResume` was eight clock steps each chased by a fixed
// ten-pump spin, a budget rather than a signal. The store persists through
// `writeFileStringAtomically` — real filesystem I/O whose completion fires on the Node event
// loop and NOT on TestClock — so on a loaded runner a turn buys less real progress and a
// budget that is generous on a laptop runs out. That is exactly what radroid/t3code#134 was:
// `pending must be cleared: expected 1 to equal +0`, an assertion that looked before the
// cancellation had landed, reported as a defect in the product.

/** The reactor's poll cadence (`config.pollMs`), and the size of one clock step here. */
const POLL_MS = 30_000;

/** A real event-loop tick. */
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

type ReceiptMatcher = (receipt: AutoResumeReactorReceipt) => boolean;

/** An arm was scheduled — optionally, the one due at `resumeAtMs`. */
const scheduled =
  (resumeAtMs?: number): ReceiptMatcher =>
  (receipt) =>
    receipt.type === "resume.scheduled" &&
    (resumeAtMs === undefined || receipt.resumeAtMs === resumeAtMs);

/** A resume attempt is over. Published after the dispatch, which may itself have failed. */
const fired: ReceiptMatcher = (receipt) => receipt.type === "resume.fired";

const firedFor =
  (threadId: string): ReceiptMatcher =>
  (receipt) =>
    receipt.type === "resume.fired" && receipt.threadId === threadId;

const scheduledFor =
  (threadId: string): ReceiptMatcher =>
  (receipt) =>
    receipt.type === "resume.scheduled" && receipt.threadId === threadId;

const cancelledFor =
  (reason: string): ReceiptMatcher =>
  (receipt) =>
    receipt.type === "resume.cancelled" && receipt.reason === reason;

const skippedFor =
  (reason: string): ReceiptMatcher =>
  (receipt) =>
    receipt.type === "resume.skipped" && receipt.reason === reason;

/** The next receipt matching `matches`. Unbounded on purpose: the test timeout is the bound. */
const untilReceipt = (matches: ReceiptMatcher) =>
  Effect.gen(function* () {
    const { log } = yield* AutoResumeReactorReceipts;
    while (true) {
      const receipt = yield* PubSub.take(log);
      if (matches(receipt)) return receipt;
    }
  });

/**
 * Advance one poll and wait out the wake pass it triggers, returning what that pass published.
 *
 * `tick.completed` is emitted after every due arm has been decided and every write is durable,
 * so when this returns the world is exactly one whole pass further on — no more and no less,
 * on any machine.
 *
 * The `realTick` is a handoff, not a budget: a pass publishes its receipt just before it
 * re-arms its own `Effect.sleep`, so this gives it the turn it needs to register that sleep
 * before the clock steps over it.
 */
const advanceOneTick = (log: PubSub.Subscription<AutoResumeReactorReceipt>) =>
  Effect.gen(function* () {
    yield* realTick;
    yield* TestClock.adjust(Duration.millis(POLL_MS));
    const seen: AutoResumeReactorReceipt[] = [];
    while (true) {
      const receipt = yield* PubSub.take(log);
      if (receipt.type === "tick.completed") return seen;
      seen.push(receipt);
    }
  });

/**
 * Advance by whole polls, waiting out each wake pass.
 *
 * This is how a scenario asserts that something does NOT happen: N passes demonstrably ran
 * and none of them did it, rather than N clock steps and a hope that the reactor kept up.
 */
const advanceTicks = (ticks: number) =>
  Effect.gen(function* () {
    const { log } = yield* AutoResumeReactorReceipts;
    for (let i = 0; i < ticks; i++) yield* advanceOneTick(log);
  });

/**
 * Advance in poll-sized steps until a wake pass publishes a matching receipt.
 *
 * `maxPolls` bounds SIMULATED time — how long the scenario is willing to wait — and says
 * nothing about the machine, so it can never expire early under load.
 */
const advanceUntilReceipt = (matches: ReceiptMatcher, description: string, maxPolls = 60) =>
  Effect.gen(function* () {
    const { log } = yield* AutoResumeReactorReceipts;
    for (let poll = 0; poll < maxPolls; poll++) {
      const hit = (yield* advanceOneTick(log)).find(matches);
      if (hit !== undefined) return hit;
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${description} after ${maxPolls} polls`),
    );
  });

describe("AutoResumeReactor (integration)", () => {
  it.effect("schedules on a rejected event and resumes once the window reopens", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store, snapshotCalls } = yield* harness(readModel({}), [
        rejectedEvent(100),
      ]);

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled());

        const calls = yield* Ref.get(snapshotCalls);
        assert.isAbove(
          calls,
          0,
          "detection should have reached getSnapshot (past classify/plan/gate)",
        );
        const pending = yield* store.listPending;
        assert.strictEqual(pending.length, 1, "detection should have scheduled a pending resume");

        const afterSchedule = yield* Ref.get(dispatched);
        assert.include(types(afterSchedule), "thread.activity.append");
        assert.notInclude(types(afterSchedule), "thread.turn.start");

        yield* advanceUntilReceipt(fired, "the resume turn");

        const afterWake = yield* Ref.get(dispatched);
        const turnStarts = afterWake.filter((c) => c.type === "thread.turn.start");
        assert.strictEqual(turnStarts.length, 1);
        const turn = turnStarts[0] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
        assert.strictEqual(turn.message.text, "continue");
        assert.strictEqual(turn.threadId, "thread-1");
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // Regression for radroid/t3code#6 — the incident shape observed in production:
  // the limit lands while the turn is RUNNING (baseline captures its id); by wake
  // time the turn has settled and the projection row has no latest_turn_id, so the
  // snapshot reports latestTurn: null. That must NOT read as "thread-advanced".
  it.effect("resumes when the limited turn has settled away by wake time (latestTurn null)", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps } = yield* harness(
        readModel({ status: "running", latestTurn: { turnId: "turn-1", state: "running" } }),
        [rejectedEvent(100)],
      );

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled()); // baseline.latestTurnId === "turn-1"

        // The limited turn settles and the session stops during the wait — the
        // projection's latest_turn_id empties out, so the snapshot's latestTurn is null.
        yield* Ref.set(modelRef, readModel({ status: "stopped", latestTurn: null }));

        yield* advanceUntilReceipt(fired, "the settled-away thread to resume");

        const commands = yield* Ref.get(dispatched);
        const turnStarts = commands.filter((c) => c.type === "thread.turn.start");
        assert.strictEqual(turnStarts.length, 1, "the settled thread must resume, not cancel");
        const summaries = commands
          .filter((c) => c.type === "thread.activity.append")
          .map((c) => (c as unknown as { activity: { summary: string } }).activity.summary);
        assert.isFalse(
          summaries.some((s) => s.includes("thread-advanced")),
          "no thread-advanced cancellation may be posted",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // --- the 2026-08-18 doomed-turn rule, end to end ------------------------------------
  // These two are a matched pair, and the pair is the point: the ONLY difference between
  // them is which side of the reopen the new turn's `completedAt` falls on. That proves
  // the window comparison is load-bearing rather than dead code, and — unlike any unit
  // test of `cancelReason` — that the reactor really hands the guard `pending.resumeAtMs`.
  //
  // Timing: resetsAt 100s + 60s margin ⇒ the arm is due at 160_000 on the TestClock.

  it.effect("resumes when the new turn died inside the still-closed window", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps } = yield* harness(
        readModel({ latestTurn: { turnId: "turn-old", state: "completed" } }),
        [rejectedEvent(100)],
      );

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled()); // baseline: "turn-old"

        // A turn is requested and dies half a second later, at t=150s — ten seconds
        // before the window reopens. It produced nothing; it only became the latest turn.
        yield* Ref.set(
          modelRef,
          readModel({
            latestTurn: {
              turnId: "turn-doomed",
              state: "completed",
              completedAt: "1970-01-01T00:02:30.000Z", // 150_000ms < 160_000ms
            },
          }),
        );

        yield* advanceUntilReceipt(fired, "the doomed turn to be ignored and the resume to fire");

        const commands = yield* Ref.get(dispatched);
        assert.strictEqual(
          commands.filter((c) => c.type === "thread.turn.start").length,
          1,
          "a turn rejected by the same limit is the blockage, not advancement",
        );
        const summaries = commands
          .filter((c) => c.type === "thread.activity.append")
          .map((c) => (c as unknown as { activity: { summary: string } }).activity.summary);
        assert.isFalse(
          summaries.some((s) => s.includes("thread-advanced")),
          "no thread-advanced cancellation may be posted",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("still cancels when the new turn outlived the window (genuine advancement)", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps } = yield* harness(
        readModel({ latestTurn: { turnId: "turn-old", state: "completed" } }),
        [rejectedEvent(100)],
      );

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled()); // baseline: "turn-old"

        // Same fixture, one field moved across the boundary: this turn finished at t=170s,
        // after the window reopened at 160s. The thread really did move on.
        yield* Ref.set(
          modelRef,
          readModel({
            latestTurn: {
              turnId: "turn-real",
              state: "completed",
              completedAt: "1970-01-01T00:02:50.000Z", // 170_000ms >= 160_000ms
            },
          }),
        );

        // The guard names its own verdict, so the wait is that verdict rather than an
        // inference from the arm having gone away.
        yield* advanceUntilReceipt(
          cancelledFor("thread-advanced"),
          "the wake pass to reach a verdict on the arm",
        );

        const commands = yield* Ref.get(dispatched);
        assert.notInclude(types(commands), "thread.turn.start");
        const activities = commands
          .filter((c) => c.type === "thread.activity.append")
          .map(
            (c) =>
              (
                c as unknown as {
                  activity: { summary: string; kind: string; payload: Record<string, unknown> };
                }
              ).activity,
          );
        assert.include(
          activities.map((a) => a.summary),
          "Auto-resume cancelled: thread-advanced.",
        );

        // The cancel must also be machine-readable. Every silent failure in this feature
        // so far was diagnosed by hand from SQL because the reason lived only in prose.
        const cancelled = activities.find((a) => a.kind === "coil.auto-resume.cancelled");
        assert.isDefined(cancelled, "a cancellation activity must be posted");
        assert.deepStrictEqual(cancelled?.payload, {
          reason: "thread-advanced",
          resumeAtMs: 160_000,
          baselineTurnId: "turn-old",
          observedTurnId: "turn-real",
          observedTurnCompletedAt: "1970-01-01T00:02:50.000Z",
        });
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // The wake loop sleeps until the earliest arm is due (capped at pollMs) instead of on a
  // fixed pollMs cadence, so fire time tracks armed time. Measured on 2026-08-18: arms due
  // at 19:51:00 fired at 19:51:42 and 19:51:47, and up to 30s of that was pure poll
  // misalignment. 160_000 is deliberately NOT a multiple of the 30s poll: under the old
  // fixed cadence the ticks landed on 150_000 then 180_000, so nothing fired at 160_000.
  it.effect("fires at the armed time, not at the next poll boundary", () =>
    Effect.gen(function* () {
      const { dispatched, deps } = yield* harness(readModel({}), [rejectedEvent(100)]);

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled(160_000));

        // t = 150_000: five whole wake passes, still ten seconds short of the reopening.
        yield* advanceTicks(5);
        assert.notInclude(
          types(yield* Ref.get(dispatched)),
          "thread.turn.start",
          "must not fire before the window reopens",
        );

        // t = 160_000 exactly: the armed moment, and a moment the old fixed cadence
        // never visited.
        yield* TestClock.adjust(Duration.millis(10_000));
        yield* untilReceipt(fired);
        assert.include(
          types(yield* Ref.get(dispatched)),
          "thread.turn.start",
          "the resume must fire at the armed time rather than the next poll",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // Regression for radroid/t3code#39 — the reported shape: the user types "keep going"
  // while the resume is pending, that message is itself rejected by a limit so it starts
  // nothing, and the arm used to be destroyed as `user-took-over`. It must survive.
  it.effect("still resumes when the user posted a message while the resume was pending", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps } = yield* harness(readModel({}), [rejectedEvent(100)]);

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled());

        // A new user message lands, and goes nowhere: the thread is still idle at wake time.
        yield* Ref.set(
          modelRef,
          readModel({
            messages: [
              { id: "u1", role: "user" },
              { id: "u2", role: "user" },
            ],
          }),
        );

        yield* advanceUntilReceipt(fired, "the resume turn");

        const commands = yield* Ref.get(dispatched);
        assert.strictEqual(
          commands.filter((c) => c.type === "thread.turn.start").length,
          1,
          "the resume must fire despite the newer user message",
        );
        const summaries = commands
          .filter((c) => c.type === "thread.activity.append")
          .map((c) => (c as unknown as { activity: { summary: string } }).activity.summary);
        assert.isFalse(
          summaries.some((s) => s.includes("cancelled")),
          "no cancellation may be posted",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // The other half of #39: a second, longer limit arriving while a resume is armed used
  // to be dropped as `already-pending`, so the arm fired into a window still shut.
  it.effect("moves a pending resume out when a longer limit supersedes it", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store } = yield* harness(readModel({}), [
        rejectedEvent(100), // due at 100_000 + 60_000 margin
        rejectedEvent(1000), // due at 1_000_000 + 60_000 margin
      ]);

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled(1_060_000));

        assert.strictEqual(
          (yield* store.listPending).length,
          1,
          "superseding replaces the arm, it does not add a second one",
        );

        const kinds = (yield* Ref.get(dispatched))
          .filter((c) => c.type === "thread.activity.append")
          .map((c) => (c as unknown as { activity: { kind: string } }).activity.kind);
        assert.deepStrictEqual(kinds, [
          "coil.auto-resume.scheduled",
          "coil.auto-resume.rescheduled",
        ]);

        // The original 160_000 due time passes without firing: that window is still shut.
        yield* advanceTicks(8); // 8 x 30s = 240_000ms
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.turn.start");

        yield* advanceUntilReceipt(fired, "the superseded resume to fire at its new time");
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("reserves the attempt before dispatch: a failed dispatch does not tight-loop", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store, failTurnStart } = yield* harness(readModel({}), [
        rejectedEvent(100),
      ]);
      yield* Ref.set(failTurnStart, true); // make the resume's turn.start dispatch fail

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled());
        // Fires once and the dispatch fails; the attempt is reserved either way, and the
        // receipt is published after the failed dispatch for exactly that reason.
        yield* advanceUntilReceipt(fired, "the attempt to be reserved");

        // The attempt was reserved (pending cleared, one fire recorded) despite the failure.
        assert.strictEqual((yield* store.listPending).length, 0);
        assert.strictEqual(yield* store.countFiredSince("thread-1", 0), 1);

        // Subsequent ticks must NOT re-dispatch — re-arming requires a fresh rejection.
        const turnStartsBefore = (yield* Ref.get(dispatched)).filter(
          (c) => c.type === "thread.turn.start",
        ).length;
        yield* advanceTicks(8);
        const turnStartsAfter = (yield* Ref.get(dispatched)).filter(
          (c) => c.type === "thread.turn.start",
        ).length;
        assert.strictEqual(turnStartsAfter, turnStartsBefore);
        assert.strictEqual(yield* store.countFiredSince("thread-1", 0), 1);
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does NOT schedule for a thread whose auto-resume is switched off", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store } = yield* harness(readModel({}), [rejectedEvent(100)]);
      yield* store.setEnabled("thread-1", false);

      yield* Effect.gen(function* () {
        // Detection announces the gate it hit, so even "nothing was scheduled" is an exact
        // await: the assertions below run after detection has demonstrably finished with the
        // pre-loaded rejection, not after a spin that hoped it had.
        yield* untilReceipt(skippedFor("disabled"));

        assert.strictEqual(
          (yield* store.listPending).length,
          0,
          "a disabled thread must never schedule a resume",
        );
        // Disabling is a deliberate user action, so it must not post timeline noise either.
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.activity.append");

        yield* advanceTicks(8);
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.turn.start");
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("cancels an already-scheduled resume when the thread is switched off mid-wait", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store } = yield* harness(readModel({}), [rejectedEvent(100)]);

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduled());
        assert.strictEqual((yield* store.listPending).length, 1, "precondition: it scheduled");

        // The switch is flipped off *after* scheduling but *before* the window reopens.
        // fireOne must re-read the record rather than trust the scheduling-time value.
        yield* store.setEnabled("thread-1", false);

        // The wait that made this test radroid/t3code#134: it was eight clock steps and a
        // turn budget, and under load the cancellation had not landed when the assertion ran.
        yield* advanceUntilReceipt(cancelledFor("disabled"), "the arm to be cancelled at wake");

        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.turn.start");
        assert.strictEqual((yield* store.listPending).length, 0, "pending must be cleared");
        assert.strictEqual(
          yield* store.countFiredSince("thread-1", 0),
          0,
          "a cancellation must not burn one of the 24h attempts",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  // `fireOne` reads a fresh snapshot per arm and `getSnapshot` has a typed
  // `ProjectionRepositoryError` channel, so one arm failing mid-pass is an expected event,
  // not a defect. Two things must survive it: the rest of the batch, and the end-of-pass
  // receipt — a pass that dies before `tick.completed` leaves anything awaiting that receipt
  // waiting for one that will never come.
  it.effect("one failed fire neither aborts the batch nor suppresses the completed pass", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store, failNextSnapshot } = yield* harness(
        readModel({ threadIds: ["thread-1", "thread-2"] }),
        [rejectedEvent(100, "thread-1"), rejectedEvent(100, "thread-2", "evt-2")],
      );

      yield* Effect.gen(function* () {
        yield* untilReceipt(scheduledFor("thread-1"));
        yield* untilReceipt(scheduledFor("thread-2"));
        // Both due at 160_000, and in this order: the pass walks `listPending`, so the
        // failure below lands on thread-1 and thread-2 is the rest of the batch.
        assert.deepStrictEqual(
          (yield* store.listPending).map((p) => p.threadId),
          ["thread-1", "thread-2"],
        );

        // The next snapshot read — the first `fireOne` of the coming pass — fails.
        yield* Ref.set(failNextSnapshot, true);

        // Both assertions at once: thread-2 fired despite thread-1 failing, and the pass
        // reached `tick.completed` at all (without it `advanceUntilReceipt` could not return,
        // because it drains to the tick receipt on every step).
        yield* advanceUntilReceipt(firedFor("thread-2"), "the rest of the batch to fire anyway");

        // Existing behaviour, pinned rather than changed: the failed fire reserved nothing and
        // cleared nothing, so the arm is untouched and the next pass tries it again.
        assert.deepStrictEqual(
          (yield* store.listPending).map((p) => p.threadId),
          ["thread-1"],
          "a failed fire must leave the arm alone, not drop it",
        );
        assert.strictEqual(
          yield* store.countFiredSince("thread-1", 0),
          0,
          "a failed fire must not burn one of the 24h attempts",
        );

        yield* advanceUntilReceipt(firedFor("thread-1"), "the failed arm to be retried");

        const turnStarts = (yield* Ref.get(dispatched)).filter(
          (c) => c.type === "thread.turn.start",
        );
        assert.deepStrictEqual(
          turnStarts.map((c) => c.threadId),
          ["thread-2", "thread-1"],
          "both threads resume: the healthy one first, the failed one on the next pass",
        );
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
});
