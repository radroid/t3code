/**
 * Pins the layer-memoisation assumption the loop console depends on.
 *
 * `coil/index.ts` gives the supervisor (`CoilLayerLive`) and the HTTP routes
 * (`CoilRoutesLive`) their record by `Layer.provide`-ing the *same* `LoopStoreLive` value to
 * each, independently. That is deliberate — leaving `LoopStore` as an open requirement on the
 * routes would widen upstream's `makeRoutesLayer` signature and break its tests.
 *
 * It only works because Effect memoises layer construction per build, so both consumers
 * receive one instance. If that stopped holding, arming from the console would write one
 * in-memory copy while the supervisor kept reading another: the UI would show an armed loop,
 * `listArmed` would stay empty, and nothing would ever check in. The failure is completely
 * silent, hence this test — and the stakes are higher here than for auto-resume, because both
 * consumers *write*, so two copies would also race each other over one file.
 *
 * SCOPE, stated honestly: this builds its own store layer and two probe services rather than
 * importing `CoilLayerLive` / `CoilRoutesLive`. It guards the *assumption* (one layer value
 * provided to two independent consumers yields one instance) for the composition shape
 * `coil/index.ts` uses — it does not exercise that file's actual graph, and would stay green
 * if someone gave each consumer its own store layer. Importing the real layers here is not
 * practical: both are `Layer.provide`d shut precisely so they leak no requirement.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { LoopStore, type LoopStoreShape, makeLoopStore } from "./state.ts";

/** Two independent consumers, mirroring the supervisor and the routes. */
class ProbeA extends Context.Service<ProbeA, { readonly store: LoopStoreShape }>()(
  "t3/coil/loop/sharing.test/ProbeA",
) {}
class ProbeB extends Context.Service<ProbeB, { readonly store: LoopStoreShape }>()(
  "t3/coil/loop/sharing.test/ProbeB",
) {}

describe("LoopStore layer sharing", () => {
  it("hands the same store instance to two consumers that each provide it independently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-share-" });
      const statePath = NodePath.join(root, "coil-loop.json");

      // Exactly the shape used in coil/index.ts: ONE layer value, provided to each consumer.
      const StoreLive = Layer.effect(LoopStore, makeLoopStore(statePath));

      const ProbeALive = Layer.effect(
        ProbeA,
        Effect.gen(function* () {
          return { store: yield* LoopStore };
        }),
      ).pipe(Layer.provide(StoreLive));

      const ProbeBLive = Layer.effect(
        ProbeB,
        Effect.gen(function* () {
          return { store: yield* LoopStore };
        }),
      ).pipe(Layer.provide(StoreLive));

      yield* Effect.gen(function* () {
        const a = yield* ProbeA;
        const b = yield* ProbeB;

        assert.strictEqual(a.store, b.store, "both consumers must share one store instance");

        // Behavioural proof, not just reference equality. This is the exact path the console
        // takes: the route arms, and the supervisor's `listArmed` has to see it.
        yield* a.store.setGlobal({ enabled: true });
        yield* a.store.arm({
          threadId: "thread-a",
          armedAtMs: 1_000,
          deadlineAtMs: 2_000_000,
          maxCheckIns: 6,
        });
        const armed = yield* b.store.listArmed;
        assert.deepStrictEqual(
          armed.map((entry) => entry.threadId),
          ["thread-a"],
          "a loop armed via one consumer must be visible to the other",
        );
        assert.isTrue((yield* b.store.getGlobal).enabled, "and so must the master toggle");

        // And back the other way: the supervisor's writes have to reach the console.
        yield* b.store.recordCheckIn({
          threadId: "thread-a",
          firedAtMs: 5_000,
          createdAtIso: "1970-01-01T00:00:05.000Z",
          activityCursor: "1970-01-01T00:00:00.000Z",
        });
        assert.strictEqual((yield* a.store.getThread("thread-a")).checkInsUsed, 1);
      }).pipe(Effect.provide(Layer.merge(ProbeALive, ProbeBLive)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));
});
