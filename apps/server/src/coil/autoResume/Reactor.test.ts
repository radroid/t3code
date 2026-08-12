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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AutoResumeReactorLive } from "./Reactor.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./state.ts";

// Defaults: safetyMargin 60s, pollMs 30s. With resetsAt=100s the resume is due at
// 100_000 + 60_000 = 160_000ms, so advancing past that (with 30s wake ticks) fires it.

// A one-Claude-thread read model. Cast because building every branded field is noise for
// this test — the reactor only reads the fields set here.
const readModel = (o: {
  messages?: Array<{ id: string; role: string }>;
  status?: string;
  latestTurnId?: string;
  /** Explicit latestTurn override; pass null to model an idle thread whose
   * projection row has no latest_turn_id (see radroid/t3code#6). */
  latestTurn?: { turnId: string; state: string } | null;
}): OrchestrationReadModel =>
  ({
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [{ id: "project-1", workspaceRoot: "/tmp/coil-nonexistent-workspace" }],
    threads: [
      {
        id: "thread-1",
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
      },
    ],
  }) as unknown as OrchestrationReadModel;

const rejectedEvent = (resetsAtSeconds: number): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: "evt-1",
    provider: "claudeAgent",
    threadId: "thread-1",
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
    const SnapshotStub = Layer.succeed(ProjectionSnapshotQuery, {
      getSnapshot: () =>
        Ref.update(snapshotCalls, (n) => n + 1).pipe(Effect.andThen(Ref.get(modelRef))),
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

    const deps = Layer.mergeAll(EngineStub, SnapshotStub, ProviderStub, CryptoStub, StoreLive);
    return { dispatched, modelRef, deps, store, snapshotCalls, failTurnStart };
  });

const types = (commands: ReadonlyArray<OrchestrationCommand>) => commands.map((c) => c.type);

// Conditions for settleUntil/advanceUntil. Each is re-evaluated on every pump, so it always
// reads fresh state rather than a value captured before the loop.
const scheduledOne = (store: { readonly listPending: Effect.Effect<ReadonlyArray<unknown>> }) =>
  store.listPending.pipe(Effect.map((pending) => pending.length === 1));

const dispatchedIncludes = (
  dispatched: Ref.Ref<OrchestrationCommand[]>,
  type: OrchestrationCommand["type"],
) => Ref.get(dispatched).pipe(Effect.map((commands) => types(commands).includes(type)));

const firedCount = (
  store: { readonly countFiredSince: (threadId: string, since: number) => Effect.Effect<number> },
  expected: number,
) => store.countFiredSince("thread-1", 0).pipe(Effect.map((n) => n === expected));

// A real event-loop tick. The store persists via writeFileStringAtomically — real
// filesystem I/O whose completion callback fires on the Node event loop, NOT on
// TestClock — and schedule() gates its in-memory ref update behind that write. So
// yieldNow alone (which only pumps the Effect fiber scheduler) never observes a just-
// scheduled resume; we must also let real I/O drain.
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

// Give forked fibers scheduling turns to subscribe/process (they are message-blocked on
// the provider stream, so TestClock.adjust alone does not run them), interleaved with
// real ticks so store persistence completes deterministically.
/** One pump of both schedulers: the Effect fiber scheduler and the real Node event loop. */
const pump = Effect.gen(function* () {
  yield* realTick;
  for (let j = 0; j < 5; j++) yield* Effect.yieldNow;
});

/**
 * A bounded spin, for asserting that something does NOT happen.
 *
 * You cannot wait for the absence of an event, so these sites keep a fixed number of turns.
 * Anything waiting for something to APPEAR must use `settleUntil` — see the note there.
 */
const settleQuiet = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* pump;
});

const MAX_SETTLE_PUMPS = 500;

/**
 * Wait until `condition` holds, pumping both schedulers.
 *
 * Condition-based rather than a fixed spin, because no tick count is correct on every machine:
 * `schedule()` gates its in-memory ref update behind `writeFileStringAtomically` — real
 * filesystem I/O that completes on the Node event loop, NOT on TestClock — and how many turns
 * that takes depends on the disk and the load.
 *
 * The fixed 10-pump spin this replaces failed about 1 run in 13 locally and took a main CI run
 * red on 2026-08-07 with `expected +0 to equal 1`: the assertion simply looked before the write
 * landed. Exiting as soon as the condition holds also makes the common case FASTER than the old
 * spin, which always paid for all ten.
 */
const settleUntil = (condition: Effect.Effect<boolean>, description: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < MAX_SETTLE_PUMPS; i++) {
      if (yield* condition) return;
      yield* pump;
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${description} after ${MAX_SETTLE_PUMPS} pumps`),
    );
  });

// Advance the test clock in wake-poll-sized steps, letting the wake fiber run each tick.
// A single large adjust does not reliably drive a recurring delay+forever loop.
const advancePastResume = Effect.gen(function* () {
  for (let i = 0; i < 8; i++) {
    yield* TestClock.adjust(Duration.millis(30_000));
    yield* settleQuiet;
  }
});

/**
 * Advance the clock until `condition` holds, for the cases that expect the wake fiber to fire.
 *
 * Same reasoning as `settleUntil`, one layer out: the wake fiber's work also ends in a store
 * write, so "advance eight times and look" has the same race. Runs a generous number of steps
 * because each one is a virtual 30s and costs only scheduler turns.
 */
const advanceUntil = (condition: Effect.Effect<boolean>, description: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 40; i++) {
      if (yield* condition) return;
      yield* TestClock.adjust(Duration.millis(30_000));
      yield* settleQuiet;
    }
    if (yield* condition) return;
    return yield* Effect.die(new Error(`timed out waiting for ${description} past the resume`));
  });

describe("AutoResumeReactor (integration)", () => {
  it.effect("schedules on a rejected event and resumes once the window reopens", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store, snapshotCalls } = yield* harness(readModel({}), [
        rejectedEvent(100),
      ]);

      yield* Effect.gen(function* () {
        yield* settleUntil(scheduledOne(store), "detection to schedule a pending resume");

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

        yield* advanceUntil(dispatchedIncludes(dispatched, "thread.turn.start"), "the resume turn");

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
      const { dispatched, modelRef, deps, store } = yield* harness(
        readModel({ status: "running", latestTurn: { turnId: "turn-1", state: "running" } }),
        [rejectedEvent(100)],
      );

      yield* Effect.gen(function* () {
        yield* settleUntil(scheduledOne(store), "detection to schedule"); // baseline.latestTurnId === "turn-1"

        // The limited turn settles and the session stops during the wait — the
        // projection's latest_turn_id empties out, so the snapshot's latestTurn is null.
        yield* Ref.set(modelRef, readModel({ status: "stopped", latestTurn: null }));

        yield* advancePastResume;

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

  // Regression for radroid/t3code#39 — the reported shape: the user types "keep going"
  // while the resume is pending, that message is itself rejected by a limit so it starts
  // nothing, and the arm used to be destroyed as `user-took-over`. It must survive.
  it.effect("still resumes when the user posted a message while the resume was pending", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps, store } = yield* harness(readModel({}), [
        rejectedEvent(100),
      ]);

      yield* Effect.gen(function* () {
        yield* settleUntil(scheduledOne(store), "detection to schedule from the pre-loaded event");

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

        yield* advanceUntil(dispatchedIncludes(dispatched, "thread.turn.start"), "the resume turn");

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
        yield* settleUntil(
          store.listPending.pipe(Effect.map((p) => p[0]?.resumeAtMs === 1_060_000)),
          "the second rejection to supersede the first arm",
        );

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
        yield* advancePastResume; // 8 x 30s = 240_000ms
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.turn.start");

        yield* advanceUntil(dispatchedIncludes(dispatched, "thread.turn.start"), "the resume turn");
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
        yield* settleUntil(scheduledOne(store), "detection to schedule");
        // Fires once and the dispatch fails; the attempt is reserved either way, which is the
        // observable signal that the wake actually ran.
        yield* advanceUntil(firedCount(store, 1), "the attempt to be reserved");

        // The attempt was reserved (pending cleared, one fire recorded) despite the failure.
        assert.strictEqual((yield* store.listPending).length, 0);
        assert.strictEqual(yield* store.countFiredSince("thread-1", 0), 1);

        // Subsequent ticks must NOT re-dispatch — re-arming requires a fresh rejection.
        const turnStartsBefore = (yield* Ref.get(dispatched)).filter(
          (c) => c.type === "thread.turn.start",
        ).length;
        yield* advancePastResume;
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
        // A bounded spin, not settleUntil: a disabled thread is gated BEFORE getSnapshot, so
        // there is no positive signal to wait for — the assertion is that nothing appears.
        yield* settleQuiet; // give detection every chance to run against the pre-loaded rejection

        assert.strictEqual(
          (yield* store.listPending).length,
          0,
          "a disabled thread must never schedule a resume",
        );
        // Disabling is a deliberate user action, so it must not post timeline noise either.
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.activity.append");

        yield* advancePastResume;
        assert.notInclude(types(yield* Ref.get(dispatched)), "thread.turn.start");
      }).pipe(Effect.provide(AutoResumeReactorLive.pipe(Layer.provideMerge(deps))));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("cancels an already-scheduled resume when the thread is switched off mid-wait", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store } = yield* harness(readModel({}), [rejectedEvent(100)]);

      yield* Effect.gen(function* () {
        yield* settleUntil(scheduledOne(store), "detection to schedule");
        assert.strictEqual((yield* store.listPending).length, 1, "precondition: it scheduled");

        // The switch is flipped off *after* scheduling but *before* the window reopens.
        // fireOne must re-read the record rather than trust the scheduling-time value.
        yield* store.setEnabled("thread-1", false);

        yield* advancePastResume;

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
});
