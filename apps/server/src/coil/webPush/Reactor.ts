/**
 * WebPushReactor — closed-tab notification supervisor.
 *
 * Self-starts one scoped fiber at layer construction (no external `.start()`, so the only
 * upstream seam stays the lines already in server.ts). It taps the hot orchestration
 * domain-event stream, and for each thread event recomputes the awareness phase from the
 * projected shell (the SAME `projectThreadAwareness` the web client uses), edge-detects, and
 * on a firing transition sends a Web Push to every registered subscription. Dead
 * subscriptions (404/410) are pruned as they surface.
 *
 * De-dup with the in-page coordinator is the service worker's job: it suppresses when a tab
 * is open, so this reactor always sends and the worker only shows when no tab exists.
 *
 * @module coil/webPush/Reactor
 */

import type { OrchestrationEvent, OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { buildAttentionPayload, createAttentionEdgeTracker } from "./attention.ts";
import { resolveConfig } from "./config.ts";
import { sendWebPush } from "./send.ts";
import { PushSubscriptionStore } from "./state.ts";
import { WebPushVapid } from "./vapid.ts";

const SEND_CONCURRENCY = 4;

/** Local mirror of the relay's `eventThreadId`, kept in-seam to avoid coupling to upstream. */
function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}

/**
 * Skip events that can never change a thread's attention phase, to avoid a shell fetch +
 * awareness recompute on every high-frequency domain event. Conservative denylist: anything
 * not listed still flows through (correctness over perf).
 */
function isPhaseRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.proposed-plan-upserted":
      return false;
    default:
      return true;
  }
}

const makeSupervisor = Effect.gen(function* () {
  const config = resolveConfig();
  if (!config.enabled) {
    yield* Effect.logInfo("coil web-push: disabled via T3X_WEB_PUSH_ENABLED");
    return;
  }

  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverEnvironment = yield* ServerEnvironment;
  const store = yield* PushSubscriptionStore;
  const vapid = yield* WebPushVapid;
  const tracker = createAttentionEdgeTracker();

  const handleThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threadOpt = yield* snapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(threadOpt)) {
        tracker.forget(threadId);
        return;
      }
      const thread = threadOpt.value;
      const projectOpt = yield* snapshotQuery.getProjectShellById(thread.projectId);
      const environmentId = yield* serverEnvironment.getEnvironmentId;

      const projectTitle = (
        Option.isSome(projectOpt) ? projectOpt.value.title : "T3 Coil"
      ) as OrchestrationProjectShell["title"];

      const state = projectThreadAwareness({
        environmentId,
        project: { title: projectTitle },
        thread,
      });
      // Observe unconditionally so the tracker stays primed even with no subscribers. A
      // transition that occurs before the first device subscribes then still fires once a
      // subscription exists, instead of being swallowed as a first-seen observation.
      const kind = tracker.observe(threadId, state?.phase ?? null);
      if (kind === null || state === null) {
        return;
      }

      const subscriptions = yield* store.list;
      if (subscriptions.length === 0) {
        return;
      }

      const payload = buildAttentionPayload(state, kind);
      yield* Effect.forEach(
        subscriptions,
        (subscription) =>
          sendWebPush(vapid, subscription, payload).pipe(
            Effect.flatMap((result) =>
              result.expired ? store.removeByEndpoint(subscription.endpoint) : Effect.void,
            ),
          ),
        { concurrency: SEND_CONCURRENCY, discard: true },
      );
    });

  yield* Effect.forkScoped(
    Stream.runForEach(engine.streamDomainEvents, (event) => {
      const threadId = eventThreadId(event);
      if (threadId === null || !isPhaseRelevantEvent(event)) {
        return Effect.void;
      }
      return handleThread(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("coil web-push: notification handler failed", {
            eventType: event.type,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }),
  );

  yield* Effect.logInfo("coil web-push: reactor started");
});

export const WebPushReactorLive = Layer.effectDiscard(makeSupervisor);
