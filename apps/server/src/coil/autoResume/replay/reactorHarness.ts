/**
 * Stage 2 of replay: canonical runtime events → the **real** `AutoResumeReactor`.
 *
 * Boots `AutoResumeReactorLive` and the real durable store against a scripted projection
 * and a recording orchestration engine, on Effect's `TestClock` so a four-hour wait for a
 * window to reopen costs milliseconds. Feed it the events stage 1 produced from a capture
 * (`adapterReplay.ts`) and it answers the question #118 could not: given exactly what the
 * provider sent, does a resume arm, and does it fire?
 *
 * Only three things are doubles, and each is a deliberate cut:
 *
 *   - **Orchestration engine** — records dispatched commands instead of running turns.
 *     Dispatch is the reactor's output; running it for real would test the decider.
 *   - **Projection snapshot** — a mutable read model the scenario scripts. The real one
 *     needs SQLite and the ingestion pipeline; see the note on grounding below.
 *   - **Provider stream** — pre-loaded with the events, so delivery is deterministic
 *     rather than dependent on publish/subscribe timing.
 *
 * The store, the reactor, its config, its guards and its persistence are all real.
 *
 * GROUNDING: the scripted projection is only trustworthy insofar as its transitions match
 * what the real ingestion pipeline writes. Scenarios that depend on a specific transition
 * (notably "what does a graceful `session.exited` do to a thread row?", which decides
 * issue #118's hypothesis 1) must be paired with a test that establishes it against the
 * real projection. Scripting an unverified transition tests the script, not the system.
 *
 * The scheduler machinery below (`pump`, `settleUntil`) is carried over from
 * `Reactor.test.ts:164-214` and its reasoning is preserved verbatim in the comments —
 * it encodes a real CI failure and should not be simplified away.
 *
 * @module coil/autoResume/replay/reactorHarness
 */

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- msToIso is a pure ms->ISO helper for fixtures; the
// value it formats is a TestClock offset, never a wall-clock reading, so DateTime's
// effectful now-semantics would add ceremony without adding correctness.
import * as NodePath from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import { AutoResumeStore, makeAutoResumeStore } from "../state.ts";

export const REPLAY_THREAD_ID = "thread-1";

/**
 * Test-clock milliseconds as an ISO timestamp, for projection fields the guards parse.
 *
 * `TestClock` begins at epoch 0, so a scenario's "now" is 1970. Guard arithmetic compares
 * a parsed `completedAt` against `arm.resumeAtMs`, which lives on that same clock — so
 * fixtures must too.
 */
export const msToIso = (ms: number): string => new Date(ms).toISOString();
export const REPLAY_PROJECT_ID = "project-1";

export interface ThreadRowOverrides {
  readonly id?: string;
  readonly messages?: ReadonlyArray<{ id: string; role: string }>;
  readonly sessionStatus?: string;
  readonly providerName?: string;
  /**
   * `completedAt` is read by the `thread-advanced` guard, which compares it against the
   * arm's `resumeAtMs`. Scenarios that omit it exercise only the no-evidence fallback, so
   * anything asserting on the timing rule MUST set it.
   *
   * Express it relative to the TEST CLOCK, not wall time: `TestClock` starts at 0, so the
   * arm's `resumeAtMs` is a few hundred thousand ms into 1970. A real 2026 timestamp here
   * would always compare as "after the window reopened" and quietly invert the scenario.
   * Use `msToIso(...)` below.
   */
  readonly latestTurn?: { turnId: string; state: string; completedAt?: string | null } | null;
  readonly deletedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly settledOverride?: string | null;
  readonly activities?: ReadonlyArray<{ kind: string; payload: unknown }>;
}

/**
 * One Claude thread in the projection read model.
 *
 * Cast rather than fully constructed: building every branded field is noise, and the
 * reactor reads only what is set here. The cast is the reason the GROUNDING note above
 * matters — nothing type-checks these values against the real projection's output.
 */
export function threadRow(overrides?: ThreadRowOverrides): unknown {
  return {
    id: overrides?.id ?? REPLAY_THREAD_ID,
    projectId: REPLAY_PROJECT_ID,
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    deletedAt: overrides?.deletedAt ?? null,
    archivedAt: overrides?.archivedAt ?? null,
    settledOverride: overrides?.settledOverride ?? null,
    messages: overrides?.messages ?? [{ id: "u1", role: "user" }],
    activities: overrides?.activities ?? [],
    // `undefined` means "not specified" and falls back to a settled turn; `null` models an
    // idle thread whose projection row has no latest_turn_id (radroid/t3code#6).
    latestTurn:
      overrides?.latestTurn !== undefined
        ? overrides.latestTurn
        : { turnId: "turn-1", state: "completed" },
    session: {
      status: overrides?.sessionStatus ?? "ready",
      providerName: overrides?.providerName ?? "claudeAgent",
    },
  };
}

/** A read model containing the given thread rows. */
export function readModel(threads: ReadonlyArray<unknown>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [{ id: REPLAY_PROJECT_ID, workspaceRoot: "/tmp/coil-nonexistent-workspace" }],
    threads,
  } as unknown as OrchestrationReadModel;
}

export interface ReplayHarness {
  readonly deps: Layer.Layer<
    | OrchestrationEngineService
    | ProjectionSnapshotQuery
    | ProviderService
    | Crypto.Crypto
    | AutoResumeStore
  >;
  readonly dispatched: Ref.Ref<OrchestrationCommand[]>;
  readonly modelRef: Ref.Ref<OrchestrationReadModel>;
  readonly store: Awaited<ReturnType<typeof makeAutoResumeStore>> extends Effect.Effect<
    infer S,
    never,
    never
  >
    ? S
    : never;
  readonly statePath: string;
}

export interface MakeReplayHarnessInput {
  /** Events delivered to the reactor, in order, before the stream parks. */
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly initialModel: OrchestrationReadModel;
}

/**
 * Build the layer stack for a replay scenario. Scoped: the state file lives in a temp
 * directory that is removed with the scope.
 */
export const makeReplayHarness = (input: MakeReplayHarnessInput) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<OrchestrationCommand[]>([]);
    const modelRef = yield* Ref.make(input.initialModel);

    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-replay-" });
    const statePath = NodePath.join(root, "state.json");

    const EngineStub = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatched, (commands) => [...commands, command]).pipe(
          Effect.as({ sequence: 0 }),
        ),
      streamDomainEvents: Stream.empty,
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as typeof OrchestrationEngineService.Service);

    const SnapshotStub = Layer.succeed(ProjectionSnapshotQuery, {
      getSnapshot: () => Ref.get(modelRef),
    } as unknown as typeof ProjectionSnapshotQuery.Service);

    const ProviderStub = Layer.succeed(ProviderService, {
      get streamEvents() {
        return Stream.concat(Stream.fromIterable(input.events), Stream.never);
      },
    } as unknown as typeof ProviderService.Service);

    const store = yield* makeAutoResumeStore(statePath);
    const StoreLive = Layer.succeed(AutoResumeStore, store);

    // Crypto.make derives randomUUIDv4 from randomBytes; a counter keeps bytes distinct so
    // generated command/message ids differ across calls.
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

    return {
      deps: Layer.mergeAll(EngineStub, SnapshotStub, ProviderStub, CryptoStub, StoreLive),
      dispatched,
      modelRef,
      store,
      statePath,
    };
  });

// --- scheduler machinery ----------------------------------------------------------
// Carried over from Reactor.test.ts:164-214. The reasoning is load-bearing, not decorative.

/**
 * A real event-loop tick. The store persists via `writeFileStringAtomically` — real
 * filesystem I/O whose completion callback fires on the Node event loop, NOT on TestClock —
 * and `schedule()` gates its in-memory ref update behind that write. So `yieldNow` alone
 * (which only pumps the Effect fiber scheduler) never observes a just-scheduled resume; we
 * must also let real I/O drain.
 */
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** One pump of both schedulers: the Effect fiber scheduler and the real Node event loop. */
export const pump = Effect.gen(function* () {
  yield* realTick;
  for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
});

/**
 * A bounded spin, for asserting that something does NOT happen.
 *
 * You cannot wait for the absence of an event, so these sites keep a fixed number of turns.
 * Anything waiting for something to APPEAR must use `settleUntil`.
 */
export const settleQuiet = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* pump;
});

const MAX_SETTLE_PUMPS = 500;

/**
 * Wait until `condition` holds, pumping both schedulers.
 *
 * Condition-based rather than a fixed spin, because no tick count is correct on every
 * machine: `schedule()` gates its in-memory ref update behind real filesystem I/O that
 * completes on the Node event loop, not on TestClock, and how many turns that takes depends
 * on the disk and the load. A fixed 10-pump spin failed about 1 run in 13 locally and took
 * a main CI run red on 2026-08-07 with `expected +0 to equal 1` — the assertion simply
 * looked before the write landed.
 */
export const settleUntil = (condition: Effect.Effect<boolean>, description: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < MAX_SETTLE_PUMPS; i++) {
      if (yield* condition) return;
      yield* pump;
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${description} after ${MAX_SETTLE_PUMPS} pumps`),
    );
  });

/**
 * Shift a capture's `resetsAt` onto the test clock's origin, preserving the interval.
 *
 * A capture carries real epochs (~1.79e12 ms). `TestClock` starts at 0, and the wake fiber
 * polls every `pollMs` (30s default) via `Effect.forever`, so advancing to a real epoch
 * would run the poll loop ~60 million times and hang the test. What the reactor's
 * behaviour actually depends on is the *interval* — how long until the window reopens —
 * so that is what is preserved: a reset 4h16m after the capture began becomes a reset
 * 4h16m after clock zero.
 *
 * Expressed in seconds, matching the SDK and `normalizeResetsAtMs`'s seconds/ms heuristic
 * (classifyRateLimit.ts:44-50).
 */
export function rebaseRateLimitEvents(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  captureStartMs: number,
): ReadonlyArray<ProviderRuntimeEvent> {
  return events.map((event) => {
    if (event.type !== "account.rate-limits.updated") return event;
    const payload = (event as unknown as { payload?: { rateLimits?: unknown } }).payload;
    const rateLimits = payload?.rateLimits;
    if (typeof rateLimits !== "object" || rateLimits === null) return event;
    const info = (rateLimits as { rate_limit_info?: unknown }).rate_limit_info;
    if (typeof info !== "object" || info === null) return event;

    const shift = (value: unknown): unknown => {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return value;
      const asMs = value < 1e12 ? value * 1000 : value;
      return Math.max(0, Math.round((asMs - captureStartMs) / 1000));
    };

    const rebasedInfo = {
      ...(info as Record<string, unknown>),
      resetsAt: shift((info as { resetsAt?: unknown }).resetsAt),
      ...((info as { overageResetsAt?: unknown }).overageResetsAt !== undefined
        ? { overageResetsAt: shift((info as { overageResetsAt?: unknown }).overageResetsAt) }
        : {}),
    };

    return {
      ...event,
      payload: {
        ...payload,
        rateLimits: { ...(rateLimits as Record<string, unknown>), rate_limit_info: rebasedInfo },
      },
    } as unknown as ProviderRuntimeEvent;
  });
}

/** Command types dispatched so far. */
export const dispatchedTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.map((command) => command.type);

/** Activity kinds the reactor appended (its only user-visible output besides the resume). */
export const appendedActivityKinds = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<string> =>
  commands
    .filter((command) => command.type === "thread.activity.append")
    .map((command) => (command as unknown as { activity: { kind: string } }).activity.kind);

/**
 * Summaries of the activities the reactor appended.
 *
 * The cancel reason is carried only in the summary text (`Auto-resume cancelled: <reason>`,
 * Reactor.ts:215-220) — it is not a structured field. Scenarios assert on it so a test
 * cannot pass because the arm was cancelled for some *other* reason than the one under
 * study. That the reason is only reachable as prose is itself a finding: nothing
 * downstream can aggregate or alert on it.
 */
export const appendedActivitySummaries = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<string> =>
  commands
    .filter((command) => command.type === "thread.activity.append")
    .map((command) => (command as unknown as { activity: { summary: string } }).activity.summary);
