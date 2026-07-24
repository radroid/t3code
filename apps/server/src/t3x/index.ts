/**
 * t3x — fork-local feature aggregator.
 *
 * Every fork-local server feature fans in here so that `apps/server/src/server.ts` needs
 * exactly ONE import and ONE `Layer.provideMerge(T3xLayerLive)` — no matter how many
 * features are added. This bounds the fork's conflict surface against upstream to a
 * single 2-line seam (see docs/t3x/SEAMS.md and the design specs under
 * docs/superpowers/specs/).
 *
 * To add a feature: build it under `apps/server/src/t3x/<feature>/`, then merge its
 * self-starting layer into `T3xLayerLive` below. Do NOT add a new edit to any
 * upstream-owned file.
 *
 * @module t3x
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { autoResumeRouteLayer } from "./autoResume/http.ts";
import { AutoResumeReactorLive } from "./autoResume/Reactor.ts";
import { AutoResumeStore, makeAutoResumeStore } from "./autoResume/state.ts";

const AUTO_RESUME_STATE_FILENAME = "t3x-auto-resume.json";

/** Wires the durable store to the server state directory. */
const AutoResumeStoreLive = Layer.effect(
  AutoResumeStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* makeAutoResumeStore(path.join(config.stateDir, AUTO_RESUME_STATE_FILENAME));
  }),
);

/**
 * The single fork-local layer merged into the server. The auto-resume supervisor
 * self-starts on construction; its store is provided here so `server.ts` merges only
 * this one layer.
 */
export const T3xLayerLive = AutoResumeReactorLive.pipe(Layer.provide(AutoResumeStoreLive));

/**
 * All fork-local HTTP routes, fanned in here for the same reason as `T3xLayerLive`:
 * `server.ts` adds ONE entry to its route list and imports it from this same module, so
 * adding future routes never grows the upstream seam.
 *
 * The store is `provide`d here rather than left as an open requirement. That matters for
 * two reasons:
 *
 *  1. **No seam leak.** An unsatisfied `AutoResumeStore` would surface in the type of
 *     upstream's `makeRoutesLayer` and fail every existing `server.test.ts` case — a fork
 *     change must never widen an upstream signature.
 *  2. **Still one instance.** Both this layer and `T3xLayerLive` provide the *same*
 *     `AutoResumeStoreLive` value, and Effect memoises layer construction per build, so
 *     the reactor and the route share a single store rather than racing two in-memory
 *     copies over one file. `index.test.ts` pins that behaviour.
 */
export const T3xRoutesLive = autoResumeRouteLayer.pipe(Layer.provide(AutoResumeStoreLive));
