// @effect-diagnostics nodeBuiltinImport:off
/**
 * Pins the layer-memoisation assumption that the auto-resume UI depends on.
 *
 * `t3x/index.ts` gives the reactor (`T3xLayerLive`) and the HTTP route (`T3xRoutesLive`)
 * their store by `Layer.provide`-ing the *same* `AutoResumeStoreLive` value to each,
 * independently. That is deliberate — leaving `AutoResumeStore` as an open requirement on
 * the route would widen upstream's `makeRoutesLayer` signature and break its tests.
 *
 * It only works because Effect memoises layer construction per build, so both consumers
 * receive one instance. If that ever stopped holding, the route would mutate its own
 * in-memory copy of the state while the reactor kept reading a stale one: toggling
 * auto-resume off in the UI would appear to work and the reactor would resume anyway.
 * That failure is completely silent, hence this test.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";

import { AutoResumeStore, type AutoResumeStoreShape, makeAutoResumeStore } from "./state.ts";

// Two independent consumers, mirroring the reactor and the route.
class ProbeA extends Context.Service<ProbeA, { readonly store: AutoResumeStoreShape }>()(
  "t3/t3x/autoResume/sharing.test/ProbeA",
) {}
class ProbeB extends Context.Service<ProbeB, { readonly store: AutoResumeStoreShape }>()(
  "t3/t3x/autoResume/sharing.test/ProbeB",
) {}

describe("AutoResumeStore layer sharing", () => {
  it("hands the same store instance to two consumers that each provide it independently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-share-" });
      const statePath = NodePath.join(root, "state.json");

      // Exactly the shape used in t3x/index.ts: ONE layer value, provided to each consumer.
      const StoreLive = Layer.effect(AutoResumeStore, makeAutoResumeStore(statePath));

      const ProbeALive = Layer.effect(
        ProbeA,
        Effect.gen(function* () {
          return { store: yield* AutoResumeStore };
        }),
      ).pipe(Layer.provide(StoreLive));

      const ProbeBLive = Layer.effect(
        ProbeB,
        Effect.gen(function* () {
          return { store: yield* AutoResumeStore };
        }),
      ).pipe(Layer.provide(StoreLive));

      yield* Effect.gen(function* () {
        const a = yield* ProbeA;
        const b = yield* ProbeB;

        assert.strictEqual(a.store, b.store, "both consumers must share one store instance");

        // Behavioural proof, not just reference equality: a write through one consumer is
        // immediately visible through the other. This is the property the UI depends on.
        yield* a.store.setEnabled("thread-a", false);
        assert.strictEqual(
          (yield* b.store.getThread("thread-a")).enabled,
          false,
          "a toggle written via one consumer must be visible to the other",
        );

        yield* b.store.setOverridePrompt("thread-a", "from b");
        assert.strictEqual((yield* a.store.getThread("thread-a")).overridePrompt, "from b");
      }).pipe(Effect.provide(Layer.merge(ProbeALive, ProbeBLive)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));
});
