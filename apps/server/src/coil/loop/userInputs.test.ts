// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { type LoopStoreShape, makeLoopStore } from "./state.ts";
import { recordUserInputs } from "./userInputs.ts";

const THREAD_ID = "thread-loop-1";

/**
 * The fields the recorder reads. Cast because building every branded field of a runtime
 * event is noise for a bookkeeping tap.
 */
const requested = (o: {
  requestId?: string;
  question?: string;
  threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "user-input.requested",
    eventId: "evt-req",
    provider: "claudeAgent",
    threadId: o.threadId ?? THREAD_ID,
    createdAt: "2026-09-02T01:04:00.000Z",
    ...(o.requestId === undefined ? {} : { requestId: o.requestId }),
    payload: {
      questions: [
        {
          id: o.question ?? "Which migration path?",
          header: "Decision",
          question: o.question ?? "Which migration path?",
          options: [],
          multiSelect: false,
        },
      ],
    },
  }) as unknown as ProviderRuntimeEvent;

const resolved = (o: {
  requestId: string;
  answers: Record<string, unknown>;
  threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "user-input.resolved",
    eventId: "evt-res",
    provider: "claudeAgent",
    threadId: o.threadId ?? THREAD_ID,
    createdAt: "2026-09-02T01:09:00.000Z",
    requestId: o.requestId,
    payload: { answers: o.answers },
  }) as unknown as ProviderRuntimeEvent;

/** An unrelated event that must be ignored without a store write. */
const unrelated: ProviderRuntimeEvent = {
  type: "turn.started",
  eventId: "evt-turn",
  provider: "claudeAgent",
  threadId: THREAD_ID,
  createdAt: "2026-09-02T01:00:00.000Z",
} as unknown as ProviderRuntimeEvent;

/**
 * A finite stub stream, so `recordUserInputs` completes and the assertions run after every
 * event has been consumed — no sleeps, no polling.
 */
const providerStub = (events: ReadonlyArray<ProviderRuntimeEvent>): ProviderServiceShape =>
  ({ streamEvents: Stream.fromIterable(events) }) as unknown as ProviderServiceShape;

const withStore = <A>(f: (store: LoopStoreShape) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-inputs-" });
    const store = yield* makeLoopStore(NodePath.join(root, "coil-loop.json"));
    return yield* f(store);
  }).pipe(Effect.scoped, Effect.orDie, Effect.provide(NodeServices.layer), Effect.runPromise);

const armed = (store: LoopStoreShape) =>
  store.arm({ threadId: THREAD_ID, armedAtMs: 1_000, deadlineAtMs: 9_000_000, maxCheckIns: 6 });

describe("coil loop user-input recording", () => {
  it("118b: a user-input.requested on an armed thread is recorded", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([unrelated, requested({ requestId: "req-1" })]),
        );

        const inputs = (yield* store.getThread(THREAD_ID)).userInputs;
        assert.strictEqual(inputs.length, 1);
        assert.strictEqual(inputs[0]!.requestId, "req-1");
        assert.strictEqual(inputs[0]!.question, "Which migration path?");
        assert.strictEqual(inputs[0]!.resolution, null);
        assert.strictEqual(inputs[0]!.resolvedAtMs, null);
        assert.isAbove(inputs[0]!.raisedAtMs, 0);
        assert.strictEqual(inputs[0]!.dialogKind, null);
      }),
    ));

  it("118c: an empty resolution is recorded as voided, not answered", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([
            requested({ requestId: "req-1" }),
            // Upstream #5127: teardown settles every pending input with `{}`.
            resolved({ requestId: "req-1", answers: {} }),
          ]),
        );

        const input = (yield* store.getThread(THREAD_ID)).userInputs[0]!;
        assert.strictEqual(input.resolution, "voided");
        assert.isNotNull(input.resolvedAtMs);
      }),
    ));

  it("118d: a genuine human answer is recorded as answered", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([
            requested({ requestId: "req-1" }),
            resolved({
              requestId: "req-1",
              answers: { "Which migration path?": "Take the migration" },
            }),
          ]),
        );

        assert.strictEqual(
          (yield* store.getThread(THREAD_ID)).userInputs[0]!.resolution,
          "answered",
        );
      }),
    ));

  it("118d: the first resolution wins, so a teardown void cannot overwrite an answer", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([
            requested({ requestId: "req-1" }),
            resolved({ requestId: "req-1", answers: { q: "yes" } }),
            resolved({ requestId: "req-1", answers: {} }),
          ]),
        );

        assert.strictEqual(
          (yield* store.getThread(THREAD_ID)).userInputs[0]!.resolution,
          "answered",
        );
      }),
    ));

  it("118h: the resume-return dialog is recorded with its dialog kind", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([
            requested({
              requestId: "req-1",
              // The exact copy upstream's resume dialog asks, recognised through the shared
              // predicate the web client already uses.
              question:
                "This session is 2h 5m old and uses 132,000 tokens. Compact it before continuing?",
            }),
          ]),
        );

        assert.strictEqual(
          (yield* store.getThread(THREAD_ID)).userInputs[0]!.dialogKind,
          "resume_return",
        );
      }),
    ));

  it("recording is idempotent on requestId", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([requested({ requestId: "req-1" }), requested({ requestId: "req-1" })]),
        );

        assert.strictEqual((yield* store.getThread(THREAD_ID)).userInputs.length, 1);
      }),
    ));

  it("an unarmed thread accrues nothing, so the shared file cannot grow without a reader", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* recordUserInputs(store, providerStub([requested({ requestId: "req-1" })]));

        assert.deepStrictEqual((yield* store.getThread(THREAD_ID)).userInputs, []);
      }),
    ));

  it("a question raised under supervision still resolves after the loop stands down", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(store, providerStub([requested({ requestId: "req-1" })]));
        yield* store.disarm(THREAD_ID);

        yield* recordUserInputs(
          store,
          providerStub([resolved({ requestId: "req-1", answers: {} })]),
        );

        assert.strictEqual((yield* store.getThread(THREAD_ID)).userInputs[0]!.resolution, "voided");
      }),
    ));

  it("a resolution for an unrecorded request creates nothing", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(
          store,
          providerStub([resolved({ requestId: "req-unknown", answers: {} })]),
        );

        assert.deepStrictEqual((yield* store.getThread(THREAD_ID)).userInputs, []);
      }),
    ));

  it("an unkeyed request is skipped rather than recorded as permanently pending", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        yield* recordUserInputs(store, providerStub([requested({})]));

        assert.deepStrictEqual((yield* store.getThread(THREAD_ID)).userInputs, []);
      }),
    ));

  it("a bookkeeping failure on one event does not tear down the subscription", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* armed(store);
        let firstCall = true;
        const flaky: LoopStoreShape = {
          ...store,
          recordUserInput: (threadId, input) => {
            if (firstCall) {
              firstCall = false;
              return Effect.sync(() => {
                throw new Error("simulated store defect");
              });
            }
            return store.recordUserInput(threadId, input);
          },
        };

        yield* recordUserInputs(
          flaky,
          providerStub([requested({ requestId: "req-1" }), requested({ requestId: "req-2" })]),
        );

        const inputs = (yield* store.getThread(THREAD_ID)).userInputs;
        assert.deepStrictEqual(
          inputs.map((entry) => entry.requestId),
          ["req-2"],
        );
      }),
    ));
});
