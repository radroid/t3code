/**
 * Test harness for the loop supervisor.
 *
 * Boots the **real** `LoopReactorLive` and the **real** durable `LoopStore` against a
 * scripted projection and a recording orchestration engine, on Effect's `TestClock` so an
 * eight-hour overnight run costs milliseconds. Only four things are doubles, and each is a
 * deliberate cut:
 *
 *   - **Orchestration engine** — records dispatched commands instead of running turns, and
 *     can be told to fail a chosen command type. Dispatch is the reactor's output.
 *   - **Projection snapshot** — two mutable shell rows the scenario scripts, read through
 *     the same `getThreadShellById` / `getProjectShellById` the reactor uses, with a call
 *     counter so "zero SQL when nothing is armed" is assertable.
 *   - **Provider** — `streamEvents` pre-loaded with the scenario's events (emit-then-block,
 *     so delivery does not depend on publish timing) and a recording `stopSession`.
 *   - **Auto-resume store** — one boolean, because guard 9 reads exactly one field.
 *
 * The store, the reactor, its config, its guards, its decision table, its sentinel reads and
 * its persistence are all real.
 *
 * The scheduler machinery below (`pump`, `settleUntil`, `advanceUntil`) is carried over from
 * `autoResume/Reactor.test.ts` and its reasoning is preserved verbatim — it encodes a real CI
 * failure and must not be simplified away.
 *
 * @module coil/loop/reactorHarness
 */

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalErrorInEffectFailure:off -- the engine stub raises bare Errors on
// purpose, mirroring the arbitrary driver throws the reactor must survive.
// @effect-diagnostics globalDate:off -- msToIso is a pure ms->ISO helper for fixtures; the
// value it formats is a TestClock offset, never a wall-clock reading.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AutoResumeStore } from "../autoResume/state.ts";
import { LOOP_DONE_RELATIVE_PATH } from "./config.ts";
import { LoopStore, makeLoopStore } from "./state.ts";

export const LOOP_THREAD_ID = "thread-1";
export const LOOP_PROJECT_ID = "project-1";

/** Handy constants so a scenario reads in the units the design talks in. */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** The reactor's default poll cadence, and therefore the granularity of every scenario. */
export const POLL_MS = MINUTE;

/**
 * Test-clock milliseconds as an ISO timestamp.
 *
 * `TestClock` begins at epoch 0, so a scenario's "now" is 1970. Every projection field the
 * trigger parses (`updatedAt`, `latestUserMessageAt`, `snoozedUntil`) is compared against
 * that clock, so a real 2026 timestamp in a fixture silently inverts the scenario.
 */
export const msToIso = (ms: number): string => new Date(ms).toISOString();

/**
 * The reactor reads `COIL_LOOP_*` once, at layer construction. A developer with any of them
 * exported would otherwise change the meaning of every timing assertion in these files.
 */
export const clearLoopEnv = (): void => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COIL_LOOP_")) delete process.env[key];
  }
};

export interface ThreadShellOverrides {
  readonly id?: string;
  readonly updatedAt?: string;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly snoozedUntil?: string | null;
  readonly sessionStatus?: string | null;
  readonly providerName?: string;
  readonly latestTurnState?: string | null;
  readonly latestUserMessageAt?: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly hasActionableProposedPlan?: boolean;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  readonly worktreePath?: string | null;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
}

/**
 * A thread shell row.
 *
 * Cast once at the end because building every branded field (`ThreadId`, `IsoDateTime`,
 * `ModelSelection`, …) is noise the reactor never reads — the fields it *does* read are all
 * set explicitly above, which is what makes the cast safe rather than a hole.
 */
export const threadShell = (o: ThreadShellOverrides = {}): OrchestrationThreadShell =>
  ({
    id: o.id ?? LOOP_THREAD_ID,
    projectId: LOOP_PROJECT_ID,
    title: "a thread",
    modelSelection: { providerName: "claudeAgent", modelId: "sonnet" },
    runtimeMode: o.runtimeMode ?? "full-access",
    interactionMode: o.interactionMode ?? "default",
    branch: null,
    worktreePath: o.worktreePath ?? null,
    latestTurn:
      o.latestTurnState === undefined || o.latestTurnState === null
        ? null
        : { turnId: "turn-1", state: o.latestTurnState },
    createdAt: msToIso(0),
    updatedAt: o.updatedAt ?? msToIso(0),
    archivedAt: o.archivedAt ?? null,
    settledOverride: o.settledOverride ?? null,
    settledAt: null,
    snoozedUntil: o.snoozedUntil ?? null,
    pinnedAt: null,
    session:
      o.sessionStatus === null
        ? null
        : {
            status: o.sessionStatus ?? "ready",
            providerName: o.providerName ?? "claudeAgent",
          },
    latestUserMessageAt: o.latestUserMessageAt ?? null,
    hasPendingApprovals: o.hasPendingApprovals ?? false,
    hasPendingUserInput: o.hasPendingUserInput ?? false,
    hasActionableProposedPlan: o.hasActionableProposedPlan ?? false,
    backgroundLiveness: o.backgroundLiveness ?? null,
  }) as unknown as OrchestrationThreadShell;

export const projectShell = (workspaceRoot: string): OrchestrationProjectShell =>
  ({
    id: LOOP_PROJECT_ID,
    title: "a project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: msToIso(0),
    updatedAt: msToIso(0),
  }) as unknown as OrchestrationProjectShell;

/** A Claude `account.rate-limits.updated` runtime event. */
export const rateLimitEvent = (o: {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAtSeconds?: number;
  readonly threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "account.rate-limits.updated",
    eventId: `evt-rl-${o.status}-${o.resetsAtSeconds ?? 0}`,
    provider: "claudeAgent",
    threadId: o.threadId ?? LOOP_THREAD_ID,
    createdAt: msToIso(0),
    payload: {
      rateLimits: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: o.status,
          rateLimitType: "five_hour",
          ...(o.resetsAtSeconds === undefined ? {} : { resetsAt: o.resetsAtSeconds }),
        },
      },
    },
  }) as unknown as ProviderRuntimeEvent;

/** A `user-input.requested` runtime event, for the two-subscriber proof. */
export const userInputRequestedEvent = (o: {
  readonly requestId: string;
  readonly question: string;
  readonly threadId?: string;
}): ProviderRuntimeEvent =>
  ({
    type: "user-input.requested",
    eventId: `evt-ui-${o.requestId}`,
    provider: "claudeAgent",
    threadId: o.threadId ?? LOOP_THREAD_ID,
    requestId: o.requestId,
    createdAt: msToIso(0),
    payload: { questions: [{ question: o.question, options: [] }] },
  }) as unknown as ProviderRuntimeEvent;

export interface HarnessOptions {
  /** The thread row the projection returns. `null` models a deleted thread. */
  readonly shell?: OrchestrationThreadShell | null;
  /** Runtime events, pre-loaded emit-then-block. */
  readonly events?: ReadonlyArray<ProviderRuntimeEvent>;
  /** Guard 9's one field. */
  readonly autoResumePending?: boolean;
  /** Additional thread rows, keyed by id, for multi-thread scenarios. */
  readonly extraShells?: ReadonlyArray<OrchestrationThreadShell>;
}

export const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "coil-loop-" });
    const workspaceRoot = NodePath.join(root, "workspace");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    const statePath = NodePath.join(root, "coil-loop.json");

    const dispatched = yield* Ref.make<OrchestrationCommand[]>([]);
    /** Command types the engine should reject, so a scenario can break exactly one path. */
    const failCommandTypes = yield* Ref.make<ReadonlySet<string>>(new Set<string>());
    /** Defect (not failure) to raise from dispatch, for the "a defect cannot kill it" cases. */
    const dieOnCommandType = yield* Ref.make<string | null>(null);
    /** Same, scoped to one thread, so a multi-thread pass can prove the others still run. */
    const dieOnThreadId = yield* Ref.make<string | null>(null);

    const EngineStub = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(dieOnCommandType)) === command.type) {
            throw new Error(`simulated defect dispatching ${command.type}`);
          }
          if (
            command.type === "thread.turn.start" &&
            (yield* Ref.get(dieOnThreadId)) === command.threadId
          ) {
            throw new Error(`simulated defect for ${command.threadId}`);
          }
          if ((yield* Ref.get(failCommandTypes)).has(command.type)) {
            return yield* Effect.fail(new Error(`simulated failure: ${command.type}`));
          }
          yield* Ref.update(dispatched, (all) => [...all, command]);
          return { sequence: 0 };
        }),
      streamDomainEvents: Stream.empty,
      readEvents: () => Stream.empty,
      latestSequence: Effect.succeed(0),
    } as unknown as typeof OrchestrationEngineService.Service);

    const shellRef = yield* Ref.make<OrchestrationThreadShell | null>(
      options.shell === undefined ? threadShell() : options.shell,
    );
    const extraShellsRef = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>(
      options.extraShells ?? [],
    );
    /**
     * Swaps in a different row once the tick has read the shell `afterCall` times, which is
     * how the wake race is scripted: the guard block sees one world and the pre-dispatch
     * re-read sees another.
     */
    const shellOverrideRef = yield* Ref.make<{
      readonly afterCall: number;
      readonly shell: OrchestrationThreadShell | null;
    } | null>(null);
    const shellCalls = yield* Ref.make(0);
    const projectCalls = yield* Ref.make(0);
    /** Set to make the projection read fail, distinct from "the thread is gone". */
    const shellReadFails = yield* Ref.make(false);
    /**
     * Fail reads only from call `n + 1` on, the same shape `shellOverrideRef` uses — which is
     * how a scenario makes the *pre-dispatch* re-read fail while the guard block's read
     * succeeded. The two are different worlds and the reactor must not conflate them.
     */
    const shellFailsAfterCall = yield* Ref.make<number | null>(null);

    const SnapshotStub = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadShellById: (threadId: string) =>
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(shellCalls, (c) => c + 1);
          const failAfter = yield* Ref.get(shellFailsAfterCall);
          if ((yield* Ref.get(shellReadFails)) || (failAfter !== null && n > failAfter)) {
            return yield* Effect.fail(new Error("simulated projection failure"));
          }
          const extra = (yield* Ref.get(extraShellsRef)).find((s) => s.id === threadId);
          if (extra) return Option.some(extra);
          const override = yield* Ref.get(shellOverrideRef);
          const shell =
            override !== null && n > override.afterCall ? override.shell : yield* Ref.get(shellRef);
          if (shell === null || shell.id !== threadId) return Option.none();
          return Option.some(shell);
        }),
      getProjectShellById: () =>
        Ref.update(projectCalls, (c) => c + 1).pipe(
          Effect.as(Option.some(projectShell(workspaceRoot))),
        ),
    } as unknown as typeof ProjectionSnapshotQuery.Service);

    const stopSessions = yield* Ref.make<string[]>([]);
    const ProviderStub = Layer.succeed(ProviderService, {
      get streamEvents() {
        return Stream.concat(Stream.fromIterable(options.events ?? []), Stream.never);
      },
      stopSession: (input: { readonly threadId: string }) =>
        Ref.update(stopSessions, (all) => [...all, input.threadId]),
    } as unknown as typeof ProviderService.Service);

    const autoResumePending = yield* Ref.make(options.autoResumePending ?? false);
    const AutoResumeStub = Layer.succeed(AutoResumeStore, {
      getThread: (_threadId: string) =>
        Ref.get(autoResumePending).pipe(
          Effect.map((pending) => ({
            enabled: true,
            overridePrompt: null,
            pending: pending ? { threadId: _threadId, resumeAtMs: 0 } : null,
            fired: [],
          })),
        ),
    } as unknown as typeof AutoResumeStore.Service);

    const store = yield* makeLoopStore(statePath);
    const StoreLive = Layer.succeed(LoopStore, store);

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

    const deps = Layer.mergeAll(
      EngineStub,
      SnapshotStub,
      ProviderStub,
      AutoResumeStub,
      CryptoStub,
      StoreLive,
    );

    return {
      deps,
      store,
      statePath,
      workspaceRoot,
      dispatched,
      failCommandTypes,
      dieOnCommandType,
      dieOnThreadId,
      shellRef,
      shellOverrideRef,
      extraShellsRef,
      shellCalls,
      projectCalls,
      shellReadFails,
      shellFailsAfterCall,
      stopSessions,
      autoResumePending,
    };
  });

/** Write the done-file with an explicit mtime **on the test clock**. */
export const writeSentinel = (workspaceRoot: string, mtimeMs: number): Effect.Effect<void> =>
  Effect.promise(async () => {
    const filePath = NodePath.join(workspaceRoot, LOOP_DONE_RELATIVE_PATH);
    await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
    await NodeFSP.writeFile(filePath, "finished\n");
    // `utimes` takes SECONDS, not milliseconds. Passing ms puts the mtime ~31 000 years out
    // and every freshness compare silently answers "fresh".
    await NodeFSP.utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  });

export const commandTypes = (commands: ReadonlyArray<OrchestrationCommand>): string[] =>
  commands.map((c) => c.type);

export const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      c.type === "thread.turn.start",
  );

export interface AppendedActivity {
  readonly kind: string;
  readonly tone: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly threadId: string;
}

export const activities = (
  commands: ReadonlyArray<OrchestrationCommand>,
): ReadonlyArray<AppendedActivity> =>
  commands
    .filter((c) => c.type === "thread.activity.append")
    .map((c) => {
      const command = c as unknown as {
        threadId: string;
        activity: { kind: string; tone: string; summary: string; payload: unknown };
      };
      return { ...command.activity, threadId: command.threadId };
    });

export const activitiesOfKind = (
  commands: ReadonlyArray<OrchestrationCommand>,
  kind: string,
): ReadonlyArray<AppendedActivity> => activities(commands).filter((a) => a.kind === kind);

// --- schedulers -------------------------------------------------------------
//
// Carried over from `autoResume/Reactor.test.ts`, comments included, because they encode a
// real CI failure: the store persists through `writeFileStringAtomically`, real filesystem
// I/O whose completion callback fires on the Node event loop and NOT on TestClock, and the
// in-memory ref update is gated behind that write. `Effect.yieldNow` alone never observes it.

/** A real event-loop tick, so store persistence completes deterministically. */
const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** One pump of both schedulers: the Effect fiber scheduler and the real Node event loop. */
export const pump = Effect.gen(function* () {
  yield* realTick;
  for (let j = 0; j < 5; j++) yield* Effect.yieldNow;
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
 * machine — how many turns a write takes depends on the disk and the load. Exiting as soon
 * as the condition holds also makes the common case faster than a fixed spin, which always
 * pays for all of it.
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

/** Advance the clock by whole poll intervals, letting the tick fiber run each one. */
export const advancePolls = (polls: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < polls; i++) {
      yield* TestClock.adjust(Duration.millis(POLL_MS));
      yield* settleQuiet;
    }
  });

/**
 * Advance the clock in poll-sized steps until `condition` holds.
 *
 * Same reasoning as `settleUntil`, one layer out: the tick fiber's work also ends in a store
 * write, so "advance N times and look" has the same race.
 *
 * ## The clock stops at the instant that satisfied the condition
 *
 * This is the whole contract, and everything below is in service of it. Each iteration looks,
 * advances **one** poll, and then spends scheduler turns on that instant until the condition
 * holds — returning the moment it does. So the clock ends where the answer was, and where the
 * answer was does not depend on how busy the machine is.
 *
 * Getting this wrong does not produce a flake that looks like a flake. The tick persists
 * through real filesystem I/O, so on a loaded runner a scheduler turn buys less real
 * progress; with a fixed handful of turns per poll, "the condition is still false" stops
 * meaning "nothing has happened yet" and starts meaning "the write has not landed yet". The
 * loop then advances anyway, and every simulated minute it borrows lands in the assertions:
 * CI reported `136c` covering one wake **twice** — the borrowed minutes carried the following
 * `advancePolls(10)` over the loop's 15-minute check-in floor — and `128` reporting a fire
 * five simulated minutes late. Both are assertion failures about the product, produced
 * entirely by the harness. `PER_POLL_TURNS` is what buys the headroom, and it costs nothing on
 * the happy path because the loop exits on the condition, not on the budget.
 *
 * Simulated time may therefore only move where a test says it moves: `advancePolls`, the
 * polls counted here, and explicit `TestClock.adjust` calls. When the poll budget runs out,
 * `settleUntil` waits on the condition with turns and **nothing else** — an earlier version
 * that nudged the clock between drain rounds is exactly how `128` lost its five minutes.
 * `reactorHarness.test.ts` pins all of this, including on the give-up path.
 */

/**
 * Scheduler turns one simulated instant may be given before the clock moves on.
 *
 * Six times what a fixed settle used to spend, and paid only while the condition is false:
 * the inner loop returns on the condition, so a run where the tick lands promptly spends two
 * or three turns here, not sixty. It is a bound on how slow a machine may be before the
 * harness starts inventing simulated time, and nothing else.
 */
export const PER_POLL_TURNS = 60;
export const advanceUntil = (
  condition: Effect.Effect<boolean>,
  description: string,
  maxPolls = 600,
) =>
  Effect.gen(function* () {
    for (let poll = 0; poll < maxPolls; poll++) {
      if (yield* condition) return;
      yield* TestClock.adjust(Duration.millis(POLL_MS));
      // Settle THIS instant before considering the next one, and stop the moment the
      // condition holds: that is what keeps the clock's resting place a property of the
      // scenario rather than of the machine.
      for (let turn = 0; turn < PER_POLL_TURNS; turn++) {
        if (yield* condition) return;
        yield* pump;
      }
    }
    // Turns, not time. `settleUntil` dies with its own message if the condition never holds.
    return yield* settleUntil(condition, description);
  });

/** `true` once at least `n` turn starts have been dispatched. */
export const turnStartsAtLeast = (dispatched: Ref.Ref<OrchestrationCommand[]>, n: number) =>
  Ref.get(dispatched).pipe(Effect.map((all) => turnStarts(all).length >= n));

/** `true` once the record has a terminal state. */
export const isStopped = (store: {
  readonly getThread: (id: string) => Effect.Effect<{ stopped: unknown }>;
}) => store.getThread(LOOP_THREAD_ID).pipe(Effect.map((record) => record.stopped !== null));
