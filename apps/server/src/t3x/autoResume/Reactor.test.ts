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
    projects: [{ id: "project-1", workspaceRoot: "/tmp/t3x-nonexistent-workspace" }],
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
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-reactor-" });
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

// A real event-loop tick. The store persists via writeFileStringAtomically — real
// filesystem I/O whose completion callback fires on the Node event loop, NOT on
// TestClock — and schedule() gates its in-memory ref update behind that write. So
// yieldNow alone (which only pumps the Effect fiber scheduler) never observes a just-
// scheduled resume; we must also let real I/O drain.
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

// Give forked fibers scheduling turns to subscribe/process (they are message-blocked on
// the provider stream, so TestClock.adjust alone does not run them), interleaved with
// real ticks so store persistence completes deterministically.
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) {
    yield* realTick;
    for (let j = 0; j < 5; j++) yield* Effect.yieldNow;
  }
});

// Advance the test clock in wake-poll-sized steps, letting the wake fiber run each tick.
// A single large adjust does not reliably drive a recurring delay+forever loop.
const advancePastResume = Effect.gen(function* () {
  for (let i = 0; i < 8; i++) {
    yield* TestClock.adjust(Duration.millis(30_000));
    yield* settle;
  }
});

describe("AutoResumeReactor (integration)", () => {
  it.effect("schedules on a rejected event and resumes once the window reopens", () =>
    Effect.gen(function* () {
      const { dispatched, deps, store, snapshotCalls } = yield* harness(readModel({}), [
        rejectedEvent(100),
      ]);

      yield* Effect.gen(function* () {
        yield* settle; // let detection process the pre-loaded event + schedule

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

        yield* advancePastResume; // past resumeAt; wake fiber fires

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
        yield* settle; // detection schedules; baseline.latestTurnId === "turn-1"

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

  it.effect("does NOT resume when the user takes over before the window reopens", () =>
    Effect.gen(function* () {
      const { dispatched, modelRef, deps } = yield* harness(readModel({}), [rejectedEvent(100)]);

      yield* Effect.gen(function* () {
        yield* settle; // detection schedules from the pre-loaded event

        // User sends a new message before the resume is due -> guard must cancel.
        yield* Ref.set(
          modelRef,
          readModel({
            messages: [
              { id: "u1", role: "user" },
              { id: "u2", role: "user" },
            ],
          }),
        );

        yield* advancePastResume;

        const commands = yield* Ref.get(dispatched);
        assert.notInclude(types(commands), "thread.turn.start");
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
        yield* settle;
        yield* advancePastResume; // fire once (dispatch fails)

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
        yield* settle; // detection runs against the pre-loaded rejection

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
        yield* settle;
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
