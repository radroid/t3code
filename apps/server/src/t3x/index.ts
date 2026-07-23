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
