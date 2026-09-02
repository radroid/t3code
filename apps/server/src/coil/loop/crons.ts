/**
 * The Claude hook callbacks that record the agent's own scheduled wakes.
 *
 * `options.hooks` is set nowhere else in this repo — 40 events, zero subscriptions — so the
 * whole subscription is built here and reaches the SDK through one additive spread in
 * `ClaudeAdapter.ts`. Three events are subscribed:
 *
 * | Event         | Matcher            | Reads               |
 * | ------------- | ------------------ | ------------------- |
 * | `Stop`        | —                  | `session_crons`     |
 * | `SubagentStop`| —                  | `session_crons`     |
 * | `PostToolUse` | `"ScheduleWakeup"` | `tool_response`     |
 *
 * ## Absent and empty are different facts
 *
 * `session_crons` is typed optional but the shipped binary always sends it — `[]` when
 * nothing is scheduled. So `[]` **clears** the record (the agent stopped self-pacing) and
 * **absent leaves it untouched** (an older or future build that does not report). Getting
 * this backwards silently retires deference: every stop would look like "no wake pending"
 * and the supervisor would nudge straight through a healthy self-paced run.
 *
 * ## Only armed threads accrue records
 *
 * Both callbacks read the record and return early unless the thread is armed. Every Claude
 * turn on the machine ends in a `Stop`, and `coil-loop.json` is rewritten in full on every
 * mutation, so recording unconditionally would mean a write per turn per thread for a table
 * nothing will ever read. The `gate_off` probe follows the same rule for the same reason —
 * a degraded state is a fact about a supervised run.
 *
 * ## A throwing hook must never break the turn
 *
 * `HookJSONOutput` carries `continue` and, for `Stop`, `decision: "block"` — **a Stop hook
 * can halt a turn.** "Observability only" is therefore a property this code holds, not one
 * the surface gives you. Every callback catches every failure *and every defect*, logs at
 * debug, and always resolves to `{ continue: true }`: never `false`, never `"block"`, never
 * `undefined`, never a rejected promise. Each matcher also carries a timeout so a wedged
 * fork callback cannot stall a turn, and an already-aborted signal short-circuits.
 *
 * ## Why `nextFireAtMs` is computed here and persisted
 *
 * The SDK delivers a cron *expression*, never a timestamp. A one-shot entry encodes a single
 * instant in those same five fields, so re-parsing it after it has fired resolves to next
 * year's occurrence — the value is only correct when computed at the moment the entry is
 * observed. That is also why the parse is logged beside the raw `schedule`: it is the
 * biggest open assumption in the design, and this is the cheap place to check it.
 *
 * @module coil/loop/crons
 */

import type {
  HookCallback,
  HookJSONOutput,
  Options as ClaudeQueryOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveConfig } from "./config.ts";
import { nextFireAtMs } from "./cron/parse.ts";
import { installedLoopStore } from "./hooksRegistry.ts";
import { type CronEntry, type CronRecord, LoopStore, type LoopStoreShape } from "./state.ts";

/** What `queryOptions.hooks` wants. Kept as an alias so the SDK owns the shape. */
export type LoopHooks = NonNullable<ClaudeQueryOptions["hooks"]>;

/**
 * Seconds. Bounds a wedged fork callback, not a slow one: everything these callbacks do is
 * an in-memory mutation plus one atomic file write.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** The tool whose response carries the gate status. See `gate_off` below. */
const SCHEDULE_WAKEUP_TOOL = "ScheduleWakeup";

/**
 * Substring probe, deliberately not a parse.
 *
 * The plumbing is verified — the matcher selects by tool name and `PostToolUseHookInput`
 * carries `tool_response` — but the response *body* is not. So a response that stringifies
 * to something containing this marker sets `degraded`, and anything else leaves `degraded`
 * exactly as it was: a successful call must never clear an unrelated degraded state by
 * accident, and a probe that finds nothing must behave exactly like no probe at all.
 */
const GATE_OFF_MARKER = "gate_off";

/** Always this, on every path. */
const CONTINUE: HookJSONOutput = { continue: true };

/**
 * Runs a hook body on the adapter's own runtime, so logs and spans land where the rest of
 * the session's do. Supplied by `loopHooksFor`; injected here so the callbacks are testable
 * without a provider.
 */
export type LoopHookRun = (effect: Effect.Effect<void>) => Promise<void>;

export interface LoopHooksInput {
  readonly store: LoopStoreShape;
  readonly threadId: string;
  readonly run: LoopHookRun;
}

/**
 * One `session_crons` entry, defensively.
 *
 * Returns `null` for anything unusable, and the caller drops it individually so one
 * malformed entry cannot cost the rest of the array. `prompt` is stored exactly as it
 * arrives — the binary already truncates it to 1000 chars with a `… [+N chars]` marker, and
 * it is console display text, never the agent's prompt.
 */
function normalizeCronEntry(raw: unknown, nowMs: number): CronEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as {
    readonly id?: unknown;
    readonly schedule?: unknown;
    readonly recurring?: unknown;
    readonly prompt?: unknown;
  };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (typeof candidate.schedule !== "string" || candidate.schedule.trim().length === 0) return null;
  return {
    id: candidate.id,
    schedule: candidate.schedule,
    recurring: candidate.recurring === true,
    prompt: typeof candidate.prompt === "string" ? candidate.prompt : "",
    // `null` = did not parse = NO deference from this entry. Never "defer forever".
    nextFireAtMs: nextFireAtMs(candidate.schedule, nowMs),
  };
}

/**
 * The snapshot to persist, or `null` when the payload says nothing.
 *
 * `null` is the "leave it alone" answer and is returned for exactly one reason: the field is
 * absent. An empty array is a statement — the agent has no pending wake — and produces a
 * record with no entries.
 */
export function normalizeCronSnapshot(sessionCrons: unknown, nowMs: number): CronRecord | null {
  if (!Array.isArray(sessionCrons)) return null;
  const entries = sessionCrons.flatMap((raw) => {
    const entry = normalizeCronEntry(raw, nowMs);
    return entry === null ? [] : [entry];
  });
  return { recordedAtMs: nowMs, entries };
}

function stringifyToolResponse(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string") return toolResponse;
  try {
    return JSON.stringify(toolResponse) ?? null;
  } catch {
    // Circular or otherwise unserializable: the probe simply finds nothing.
    return null;
  }
}

const recordCronSnapshot = (
  store: LoopStoreShape,
  threadId: string,
  event: string,
  sessionCrons: unknown,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Armed only. These callbacks run on the Stop of EVERY Claude turn on the machine, and
    // `coil-loop.json` is rewritten in full on every mutation — recording a cron table for
    // threads nothing supervises would grow one shared file by a write per turn for no
    // reader at all. Same rule as `userInputs.ts`.
    if (!(yield* store.getThread(threadId)).armed) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const snapshot = normalizeCronSnapshot(sessionCrons, nowMs);
    if (snapshot === null) {
      yield* Effect.logDebug("coil loop: stop hook reported no session_crons field", {
        threadId,
        event,
      });
      return;
    }
    yield* store.setCrons(threadId, snapshot);
    // The parse beside the raw expression: this log is how the biggest open assumption in
    // the design gets checked against what actually fires.
    yield* Effect.logDebug("coil loop: recorded the agent's scheduled wakes", {
      threadId,
      event,
      entries: snapshot.entries.map((entry) => ({
        id: entry.id,
        schedule: entry.schedule,
        recurring: entry.recurring,
        nextFireAtMs: entry.nextFireAtMs,
      })),
    });
  });

const probeGateOff = (
  store: LoopStoreShape,
  threadId: string,
  toolResponse: unknown,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const text = stringifyToolResponse(toolResponse);
    if (text === null || !text.toLowerCase().includes(GATE_OFF_MARKER)) return;
    // Armed only, for the same reason the cron snapshot is: `degraded` is a fact about a
    // supervised run, and only a supervised run has anywhere to show it.
    if (!(yield* store.getThread(threadId)).armed) return;
    yield* store.setDegraded(threadId, "gate_off");
    yield* Effect.logDebug("coil loop: scheduler gate reported off", { threadId });
  });

/**
 * The boundary. Nothing past this point can reach the turn: an aborted signal returns
 * immediately, a failure or defect inside the body is logged and swallowed, a rejected
 * promise is swallowed, and a synchronous throw while starting the effect is swallowed.
 */
function settle(
  run: LoopHookRun,
  signal: AbortSignal,
  body: () => Effect.Effect<void>,
): Promise<HookJSONOutput> {
  if (signal.aborted) return Promise.resolve(CONTINUE);
  try {
    return run(
      Effect.suspend(body).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("coil loop: hook callback failed", { cause: Cause.pretty(cause) }),
        ),
      ),
    ).then(
      () => CONTINUE,
      () => CONTINUE,
    );
  } catch {
    return Promise.resolve(CONTINUE);
  }
}

/**
 * The `hooks` object for one Claude session.
 *
 * Takes no `LoopConfig`: the deployment kill switch is read once in `loopHooksFor` (no hooks
 * object is built at all when it is off), and nothing else in this module is tunable.
 */
export function makeLoopHooks(input: LoopHooksInput): LoopHooks {
  const { store, threadId, run } = input;

  // `Stop` and `SubagentStop` are handled identically: both carry the same session-scoped
  // cron table, and a subagent finishing is as good a moment to read it as the main loop.
  const onStop: HookCallback = (hookInput, _toolUseId, options) =>
    settle(run, options.signal, () =>
      recordCronSnapshot(
        store,
        threadId,
        hookInput.hook_event_name,
        "session_crons" in hookInput ? hookInput.session_crons : undefined,
      ),
    );

  const onScheduleWakeup: HookCallback = (hookInput, _toolUseId, options) =>
    settle(run, options.signal, () =>
      hookInput.hook_event_name === "PostToolUse" && hookInput.tool_name === SCHEDULE_WAKEUP_TOOL
        ? probeGateOff(store, threadId, hookInput.tool_response)
        : Effect.void,
    );

  return {
    Stop: [{ hooks: [onStop], timeout: HOOK_TIMEOUT_SECONDS }],
    SubagentStop: [{ hooks: [onStop], timeout: HOOK_TIMEOUT_SECONDS }],
    PostToolUse: [
      { matcher: SCHEDULE_WAKEUP_TOOL, hooks: [onScheduleWakeup], timeout: HOOK_TIMEOUT_SECONDS },
    ],
  };
}

/**
 * The adapter's whole entry point: one `yield*` that resolves to the hooks object, or
 * `undefined` when loops are not in play.
 *
 * `Effect.serviceOption` is what keeps this free: reading `LoopStore` optionally means the
 * adapter's Layer requirements do not widen, so no second seam edit appears in `server.ts`
 * or in upstream's adapter tests. But it is not what makes it *work* in production — the
 * adapter's fiber runs in upstream's layer graph, where `CoilLayerLive` has already
 * discharged `LoopStore` with `Layer.provide`, so the service is genuinely absent there.
 * `hooksRegistry.ts` is the fallback the running supervisor installs; the context is still
 * preferred when one carries the store, which is how every test that provides it stays
 * honest. A server with no loop layer at all finds neither and gets `undefined`.
 *
 * The runtime context is captured from the caller either way, so hook logs and spans belong
 * to the session that owns them.
 */
export const loopHooksFor = (threadId: string): Effect.Effect<LoopHooks | undefined> =>
  Effect.gen(function* () {
    if (!resolveConfig().enabled) return undefined;
    const fromContext = yield* Effect.serviceOption(LoopStore);
    const store = Option.isSome(fromContext) ? fromContext.value : installedLoopStore();
    if (store === null) return undefined;
    const context = yield* Effect.context<never>();
    return makeLoopHooks({ store, threadId, run: Effect.runPromiseWith(context) });
  });
