/**
 * Stage 1 of replay: an episode's native SDK messages → the **real** `ClaudeAdapter`.
 *
 * Answers one question precisely: given exactly what the provider sent, what canonical
 * runtime events does the adapter produce today? That is the half of the auto-resume chain
 * no existing test covers — `Reactor.test.ts` hands the reactor hand-written
 * `ProviderRuntimeEvent`s, so a defect in how the adapter reads a payload (a new overage
 * field, a renamed status) is invisible to it. Feeding captured bytes through the adapter
 * closes that gap.
 *
 * Replay is deliberately split in two clock domains, because they cannot share one:
 *
 *   - **Stage 1 (here, real clock).** Draining an `AsyncIterable` requires the JS event
 *     loop to turn. Under Effect's `TestClock` nothing advances unless the test advances
 *     it, so an adapter waiting on a promise and a test waiting on the adapter deadlock.
 *     Stage 1 involves no waiting — it just pushes messages — so a real clock is correct
 *     and fast.
 *   - **Stage 2 (`reactorReplay.ts`, TestClock).** The reactor's job is *waiting* — hours,
 *     for a window to reopen. It consumes the events stage 1 produced, so the seam between
 *     them is honest: stage 2 is driven by what the adapter really emitted, not by
 *     hand-written events.
 *
 * @module coil/autoResume/replay/adapterReplay
 */

import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeClaudeAdapter } from "../../../provider/Layers/ClaudeAdapter.ts";
import type { Episode } from "./episode.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * A push-driven `ClaudeQueryRuntime` double.
 *
 * Mirrors `FakeClaudeQuery` in ClaudeAdapter.test.ts (:48-155) — kept as its own copy
 * rather than exported from that file, because a test file exporting helpers into
 * production-adjacent modules is a merge-conflict magnet on a fork that rebases onto
 * upstream weekly, and this copy is ~40 lines.
 */
class ReplayQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private done = false;

  public closeCalls = 0;

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  readonly interrupt = async (): Promise<void> => {};
  readonly stopTask = async (): Promise<void> => {};
  readonly setModel = async (): Promise<void> => {};
  readonly setPermissionMode = async (_mode: PermissionMode): Promise<void> => {};
  readonly setMaxThinkingTokens = async (): Promise<void> => {};
  readonly getContextUsage = async (): Promise<SDKControlGetContextUsageResponse> =>
    ({}) as SDKControlGetContextUsageResponse;
  readonly close = (): void => {
    this.closeCalls += 1;
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface AdapterReplayOptions {
  /**
   * How long to let the adapter drain after the last message, in ms.
   *
   * The adapter consumes the iterable on its own fiber, so "everything has been emitted"
   * is not "everything has been processed". Rather than sleep blindly, the driver polls
   * for quiescence and only uses this as a ceiling.
   */
  readonly settleMs?: number;
  /** Poll interval while waiting for the event count to stop growing. */
  readonly pollMs?: number;
}

export interface AdapterReplayResult {
  /** Canonical runtime events the real adapter produced from the episode's natives. */
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  /** Native messages fed in. */
  readonly emitted: number;
}

const REPLAY_THREAD_ID = ThreadId.make("11111111-1111-4111-8111-111111111111");

/**
 * Feed an episode's native messages through a real `ClaudeAdapter` and collect what it
 * emits. Runs on the real clock; the episode's recorded offsets are NOT slept through —
 * ordering is what matters here, and stage 2 owns time.
 */
export const replayThroughAdapter = (
  episode: Episode,
  options?: AdapterReplayOptions,
): Effect.Effect<AdapterReplayResult> =>
  Effect.gen(function* () {
    const settleMs = options?.settleMs ?? 2_000;
    const pollMs = options?.pollMs ?? 25;

    const query = new ReplayQuery();
    const adapter = yield* makeClaudeAdapter(decodeClaudeSettings({}), {
      createQuery: (_input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query,
    });

    const collected = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
    const collector = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Ref.update(collected, (events) => [...events, event]),
    ).pipe(Effect.forkChild);

    const session = yield* adapter.startSession({
      threadId: REPLAY_THREAD_ID,
      provider: ProviderDriverKind.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
      },
      runtimeMode: "full-access",
    });

    // A turn must be open for the adapter to attribute item/turn events; the episode's own
    // messages then drive everything that follows.
    yield* adapter.sendTurn({
      threadId: session.threadId,
      input: "replay",
      attachments: [],
    });

    for (const step of episode.native) {
      query.emit(step.message as SDKMessage);
    }
    query.finish();

    // Quiesce: wait until the collected count stops growing, capped at settleMs.
    let stable = 0;
    let previous = -1;
    const deadline = Math.ceil(settleMs / pollMs);
    for (let tick = 0; tick < deadline && stable < 3; tick++) {
      yield* Effect.sleep(Duration.millis(pollMs));
      const current = (yield* Ref.get(collected)).length;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }

    yield* Fiber.interrupt(collector);
    const events = yield* Ref.get(collected);
    return { events, emitted: episode.native.length };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest("/tmp/coil-autoresume-replay", "/tmp"),
        ServerSettingsService.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.orDie,
  );

/** Canonical events of a given type, for assertions. */
export function eventsOfType(
  result: AdapterReplayResult,
  type: string,
): ReadonlyArray<ProviderRuntimeEvent> {
  return result.events.filter((event) => event.type === type);
}

/**
 * Event types a native-message replay can never reproduce, by construction.
 *
 * The adapter has **two** input channels, and a capture only records one. Besides the
 * SDK message stream, the SDK calls back into the adapter for tool permission
 * (`canUseTool`), and that path emits its own runtime events while blocking on a
 * `Deferred` the host resolves (ClaudeAdapter.ts:3892-3912). No message in the stream
 * triggers them, so replaying messages alone cannot produce them.
 *
 * This matters directly for auto-resume: the `awaiting-input` guard reads exactly these
 * interactions (`guards.ts:52-76`). A replay must therefore *script* a blocked thread
 * rather than expect the fixture to generate one — expecting otherwise would quietly
 * test nothing.
 */
export const CALLBACK_DERIVED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user-input.requested",
  "user-input.resolved",
]);

/**
 * Canonical event types the capture recorded that this replay did not reproduce,
 * excluding the ones no replay could.
 *
 * A non-empty result means the adapter's behaviour has drifted since the capture: it used
 * to turn these messages into an event and no longer does.
 */
export function missingRecordedEventTypes(
  episode: Episode,
  result: AdapterReplayResult,
): ReadonlyArray<string> {
  const produced = new Set<string>(result.events.map((event) => event.type));
  return [...new Set(episode.canonical.map((entry) => entry.type))]
    .filter((type) => !CALLBACK_DERIVED_EVENT_TYPES.has(type))
    .filter((type) => !produced.has(type));
}
