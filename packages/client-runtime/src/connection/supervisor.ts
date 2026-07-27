import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionAttemptStage,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
// A reconnect attempt that reached the backend (the socket opened / we began
// synchronizing) but then timed out is treated as "slow, not dead": the next
// attempt gets this enlarged establishment budget so a briefly-overloaded — but
// still alive — backend is not repeatedly abandoned before it can answer. This
// is the client half of issue #21 (host memory pressure makes the local backend
// slow, not gone). A timeout that never reached the backend keeps the normal
// budget + exponential backoff below.
const SLOW_CONNECTION_ESTABLISHMENT_TIMEOUT = "45 seconds";
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
// After a slow timeout we retry promptly instead of climbing the exponential
// ladder — the enlarged establishment budget already paces the attempts, and the
// backend is known to be reachable.
const SLOW_RETRY_DELAY_MS = 1_000;
// The stages we key "slow, not dead" off (opening/synchronizing) are reported
// before the socket is confirmed open, so a genuinely unreachable endpoint can
// be misclassified as slow. Bound the tolerant path: after this many consecutive
// slow timeouts we fall back to the normal budget + exponential backoff, so a
// dead endpoint still surfaces backoff and a truly slow-but-alive backend has
// had ample time (a few 45s attempts) to answer.
const MAX_TOLERANT_TIMEOUTS = 3;
// While connected, actively probe the backend on this cadence so a wedged — but
// still open — socket is detected in the background, not only when the app is
// brought to the foreground.
const CONNECTION_HEARTBEAT_INTERVAL = "30 seconds";
const BACKOFF_RESET_AFTER_MS = 30_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<
        {
          readonly attemptSpan: Option.Option<Tracer.Span>;
          readonly lease: ConnectionDriver.EnvironmentConnectionLease;
        },
        TracedAttemptFailure
      >;
    }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "TimedOut" };

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
}

function retryDelayMs(failureCount: number): number {
  return RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)] ?? 16_000;
}

const STAGE_RANK: Record<ConnectionAttemptStage, number> = {
  preparing: 1,
  opening: 2,
  synchronizing: 3,
};

function furthestStage(
  current: ConnectionAttemptStage | null,
  next: ConnectionAttemptStage,
): ConnectionAttemptStage {
  return current === null || STAGE_RANK[next] > STAGE_RANK[current] ? next : current;
}

// True once an attempt has begun talking to the backend (socket opening or
// later). A timeout at or past this point means the backend is reachable but
// slow, so we should be patient rather than escalate backoff.
function reachedBackend(stage: ConnectionAttemptStage | null): boolean {
  return stage !== null && STAGE_RANK[stage] >= STAGE_RANK.opening;
}

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function failureFromExit<A>(
  target: ConnectionTarget,
  exit: Exit.Exit<A, TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", established, stable };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  if (typedFailure) {
    return {
      _tag: "Failure",
      established,
      stable,
      failure: typedFailure.error,
    };
  }
  return {
    _tag: "Failure",
    established,
    stable,
    failure: {
      error: new ConnectionTransientError({
        reason: "transport",
        detail: `${target.label} connection failed unexpectedly.`,
      }),
      attemptSpan: Option.none(),
    },
  };
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const target = entry.target;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };
  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  // Tracks how far the current attempt progressed. Read after an attempt fails
  // to distinguish a slow-but-reachable backend from an unreachable one. The
  // supervisor runs a single attempt at a time, so a shared Ref is safe.
  const attemptFurthestStage = yield* Ref.make<ConnectionAttemptStage | null>(null);

  const clearLease = Effect.all(
    [SubscriptionRef.set(session, Option.none()), SubscriptionRef.set(prepared, Option.none())],
    { discard: true },
  );

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, next);
  });

  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    yield* Queue.offer(signals, next);
  });

  const logManagedRelayAccountChange = Effect.logInfo(
    "Managed relay account changed; restarting the environment connection.",
  ).pipe(
    Effect.annotateLogs({
      "environment.id": target.environmentId,
      "environment.label": target.label,
    }),
  );

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    yield* Ref.update(attemptFurthestStage, (current) => furthestStage(current, progress.stage));
    yield* setState(
      connectingState(yield* Ref.get(intent), generation, attempt, lastFailure, progress.stage),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
  ) {
    return yield* driver.connect(entry, (progress) =>
      reportProgress(attempt, generation, lastFailure, progress),
    );
  });

  const traceRelayEstablishment = (
    effect: Effect.Effect<
      ConnectionDriver.EnvironmentConnectionLease,
      ConnectionAttemptError,
      Scope.Scope
    >,
    attempt: number,
    generation: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) => {
    const traced = Effect.gen(function* () {
      const attemptSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      yield* annotateTarget(target);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.generation": generation,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      const lease = yield* effect.pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: Option.some(attemptSpan),
          }),
        ),
      );
      return { attemptSpan: Option.some(attemptSpan), lease };
    }).pipe(Effect.withSpan("relay.connection.attempt", { root: true }));

    return Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    }).pipe(withRelayClientTracing);
  };

  const establishTracedConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) {
    if (target._tag === "RelayConnectionTarget") {
      return yield* traceRelayEstablishment(
        establishConnection(attempt, generation, lastFailure),
        attempt,
        generation,
        pendingRetry,
      );
    }
    return yield* establishConnection(attempt, generation, lastFailure).pipe(
      Effect.map((lease) => ({
        attemptSpan: Option.none<Tracer.Span>(),
        lease,
      })),
      Effect.mapError(
        (error): TracedAttemptFailure => ({
          error,
          attemptSpan: Option.none(),
        }),
      ),
    );
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return;
        case "NetworkChanged":
          if (next.network === "offline") {
            return;
          }
          break;
        case "ConnectRequested":
          break;
        case "Wakeup":
          if (next.reason === "credentials-changed" && target._tag === "RelayConnectionTarget") {
            yield* logManagedRelayAccountChange;
            return;
          }
          break;
      }
    }
  });

  // Runs a single liveness probe against the active lease while staying
  // responsive to supervisor signals. Returns "continue" when the probe succeeds
  // (stay connected) or "return" when a signal (disconnect / retry / offline)
  // asks us to stop monitoring. Fails with a ConnectionTransientError when the
  // probe fails or times out, which the caller surfaces as a reconnect.
  const runLivenessProbe = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const probe = yield* lease.session.probe.pipe(
      Effect.timeoutOrElse({
        duration: CONNECTION_PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "timeout",
              detail: `${target.label} did not respond to a connection health check.`,
            }),
          ),
      }),
      Effect.forkChild,
    );
    for (;;) {
      const probeEvent = yield* Effect.raceFirst(
        Fiber.await(probe).pipe(Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit }))),
        Queue.take(signals).pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
      );
      if (probeEvent._tag === "ProbeCompleted") {
        yield* probeEvent.exit;
        return "continue" as const;
      }
      switch (probeEvent.signal._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          yield* Fiber.interrupt(probe);
          return "return" as const;
        case "NetworkChanged":
          if (probeEvent.signal.network === "offline") {
            yield* Fiber.interrupt(probe);
            return "return" as const;
          }
          break;
        case "Wakeup":
          // A relay credentials change must still tear down and reconnect even
          // if it lands while a probe is in flight — otherwise the enclosing
          // monitor would only see it on the next signal, leaving the session on
          // stale credentials. Mirror monitorConnectedLease's handling.
          if (
            probeEvent.signal.reason === "credentials-changed" &&
            target._tag === "RelayConnectionTarget"
          ) {
            yield* Fiber.interrupt(probe);
            yield* logManagedRelayAccountChange;
            return "return" as const;
          }
          break;
        case "ConnectRequested":
          break;
      }
    }
  });

  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    for (;;) {
      // Wait for the next signal, but wake on a heartbeat interval too so a
      // wedged-but-open socket is probed in the background rather than only when
      // the app is activated. An interrupted Queue.take does not consume a
      // signal, so the loser of this race is not lost.
      const event = yield* Effect.raceFirst(
        Queue.take(signals).pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
        Effect.sleep(CONNECTION_HEARTBEAT_INTERVAL).pipe(Effect.as({ _tag: "Heartbeat" as const })),
      );
      if (event._tag === "Heartbeat") {
        if ((yield* runLivenessProbe(lease)) === "return") {
          return;
        }
        continue;
      }
      const next = event.signal;
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return;
        case "NetworkChanged":
          if (next.network === "offline") {
            return;
          }
          break;
        case "Wakeup":
          if (next.reason === "credentials-changed" && target._tag === "RelayConnectionTarget") {
            yield* logManagedRelayAccountChange;
            return;
          }
          if (next.reason === "application-active") {
            if ((yield* runLivenessProbe(lease)) === "return") {
              return;
            }
          }
          break;
        case "ConnectRequested":
          break;
      }
    }
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    tolerant: boolean,
  ) {
    yield* Ref.set(attemptFurthestStage, null);
    yield* SubscriptionRef.set(prepared, Option.none());
    const establishmentTimeout = tolerant
      ? SLOW_CONNECTION_ESTABLISHMENT_TIMEOUT
      : CONNECTION_ESTABLISHMENT_TIMEOUT;
    const establishment = yield* Effect.raceAllFirst([
      exitUnlessInterrupted(
        establishTracedConnection(attempt, generation, lastFailure, pendingRetry),
      ).pipe(
        Effect.map(
          (exit): EstablishmentEvent => ({
            _tag: "Completed",
            exit,
          }),
        ),
      ),
      waitForEstablishmentInterrupt().pipe(Effect.as<EstablishmentEvent>({ _tag: "Interrupted" })),
      Effect.sleep(establishmentTimeout).pipe(Effect.as<EstablishmentEvent>({ _tag: "TimedOut" })),
    ]);

    if (establishment._tag === "Interrupted") {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
      } satisfies AttemptOutcome;
    }
    if (establishment._tag === "TimedOut") {
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        failure: {
          error: new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond during connection setup.`,
          }),
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      const isUnexpectedDefect =
        !Cause.hasInterruptsOnly(establishment.exit.cause) &&
        !establishment.exit.cause.reasons.some(Cause.isFailReason);
      const outcome = failureFromExit(target, establishment.exit, false, false);
      if (isUnexpectedDefect) {
        const defect = establishment.exit.cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "cause.reason_count": establishment.exit.cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }
      return outcome;
    }

    const active = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || currentIntent.network === "offline") {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
      } satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(prepared, Option.some(active.lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(active.lease.session));
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation,
      lastFailure: null,
      retryAt: null,
    });

    const connectedExit = yield* Effect.raceFirst(
      active.lease.session.closed.pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: active.attemptSpan,
          }),
        ),
      ),
      monitorConnectedLease(active.lease).pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: active.attemptSpan,
          }),
        ),
      ),
    ).pipe(exitUnlessInterrupted);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    return failureFromExit(target, connectedExit, true, connectedForMs >= BACKOFF_RESET_AFTER_MS);
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          switch (next._tag) {
            case "ConnectRequested":
            case "DisconnectRequested":
            case "RetryRequested":
            case "NetworkChanged":
            case "Wakeup":
              return;
          }
        }
      }),
    );
  });

  const waitForSignal = Queue.take(signals);

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let generation = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    // When true, the previous attempt timed out after reaching the backend, so
    // the next attempt gets the enlarged establishment budget. Bounded by
    // consecutiveSlowTimeouts so a misclassified dead endpoint reverts to
    // exponential backoff.
    let tolerant = false;
    let consecutiveSlowTimeouts = 0;

    for (;;) {
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        failureCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
        tolerant = false;
        consecutiveSlowTimeouts = 0;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }
      if (currentIntent.network === "offline") {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        yield* waitForSignal;
        continue;
      }

      const attempt = failureCount + 1;
      const nextGeneration = generation + 1;
      const outcome: AttemptOutcome = yield* Effect.scoped(
        runAttempt(attempt, nextGeneration, latestFailure, pendingRetry, tolerant),
      );
      if (outcome.established) {
        generation = nextGeneration;
        if (outcome.stable) {
          failureCount = 0;
          latestFailure = null;
          pendingRetry = Option.none();
          tolerant = false;
          consecutiveSlowTimeouts = 0;
        }
      }
      if (outcome._tag === "Interrupted") {
        continue;
      }

      const attemptSpan: Option.Option<Tracer.Span> = outcome.failure.attemptSpan;
      const error: ConnectionAttemptError = outcome.failure.error;
      latestFailure = error;
      if (error._tag === "ConnectionBlockedError") {
        tolerant = false;
        consecutiveSlowTimeouts = 0;
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        yield* waitForSignal;
        continue;
      }

      failureCount += 1;
      // A timeout that reached the backend means it is (probably) alive but slow:
      // retry promptly and grant the next attempt the enlarged budget instead of
      // climbing the exponential ladder — but only up to MAX_TOLERANT_TIMEOUTS in
      // a row, after which we assume the endpoint is really unreachable and fall
      // back to normal backoff. Every other failure keeps the existing behaviour.
      const furthest = yield* Ref.get(attemptFurthestStage);
      const reachedBackendTimeout: boolean = error.reason === "timeout" && reachedBackend(furthest);
      const slowTimeout: boolean =
        reachedBackendTimeout && consecutiveSlowTimeouts < MAX_TOLERANT_TIMEOUTS;
      consecutiveSlowTimeouts = slowTimeout ? consecutiveSlowTimeouts + 1 : 0;
      tolerant = slowTimeout;
      const delayMs = slowTimeout ? SLOW_RETRY_DELAY_MS : retryDelayMs(failureCount - 1);
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: error,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      yield* waitForRetrySignal(delayMs);
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal({ _tag: "NetworkChanged", network }) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = signal({ _tag: "RetryRequested" }).pipe(
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});

export const layer = (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Layer.Layer<
  EnvironmentSupervisor,
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | ConnectionWakeups.ConnectionWakeups
> => Layer.effect(EnvironmentSupervisor, make(entry, options));
