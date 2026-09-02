/**
 * The one `LoopStore` layer value, shared by everything that touches `coil-loop.json`.
 *
 * The reactor, the HTTP routes and the MCP toolkit all mutate the same single JSON file, so
 * they must resolve to the same in-memory store. Effect memoises layer construction per
 * build keyed on **layer identity**, so this module-level value — imported, never
 * re-declared — is what makes that true. `coil/index.ts` uses the identical trick for
 * `AutoResumeStoreLive` and `WebPushDepsLive`, and documents why: two copies over one file
 * means the console's write is invisible to the supervisor's read.
 *
 * It lives here rather than in `coil/index.ts` because the MCP toolkit registration hangs
 * off `mcp/McpHttpServer.ts`, which is on the other side of the layer graph from the coil
 * aggregator. If the toolkit left `LoopStore` as an open requirement instead, the gap would
 * surface in upstream's `makeRoutesLayer` signature — a second seam edit for nothing.
 *
 * @module coil/loop/layer
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { LoopStore, makeLoopStore } from "./state.ts";

export const LOOP_STATE_FILENAME = "coil-loop.json";

/** Wires the durable store to the server state directory. Import this; do not re-declare it. */
export const LoopStoreLive = Layer.effect(
  LoopStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return yield* makeLoopStore(path.join(config.stateDir, LOOP_STATE_FILENAME));
  }),
);
