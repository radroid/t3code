import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { reconcileInterruptedTurnsOnBoot } from "./CrashRecoveryReconciler.ts";

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

async function createReconcilerSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-crash-recovery-reconciler-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const turnRepository = await runtime.runPromise(Effect.service(ProjectionTurnRepository));

  return {
    dispatch: (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command)),
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    reconcile: () => runtime.runPromise(reconcileInterruptedTurnsOnBoot),
    getTurn: (threadId: string, turnId: string) =>
      runtime.runPromise(
        turnRepository.getByTurnId({
          threadId: ThreadId.make(threadId),
          turnId: TurnId.make(turnId),
        }),
      ),
    readEvents: () =>
      runtime.runPromise(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}

type ReconcilerSystem = Awaited<ReturnType<typeof createReconcilerSystem>>;

async function seedProject(system: ReconcilerSystem, projectId: string) {
  await system.dispatch({
    type: "project.create",
    commandId: CommandId.make(`cmd-project-${projectId}`),
    projectId: ProjectId.make(projectId),
    title: `Project ${projectId}`,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: MODEL_SELECTION,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

async function seedThread(system: ReconcilerSystem, projectId: string, threadId: string) {
  await system.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-${threadId}`),
    threadId: ThreadId.make(threadId),
    projectId: ProjectId.make(projectId),
    title: `Thread ${threadId}`,
    modelSelection: MODEL_SELECTION,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:01.000Z",
  });
}

async function setSession(
  system: ReconcilerSystem,
  threadId: string,
  status: "running" | "stopped",
  activeTurnId: string | null,
  updatedAt: string,
) {
  await system.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`cmd-session-${threadId}-${status}-${updatedAt}`),
    threadId: ThreadId.make(threadId),
    session: {
      threadId: ThreadId.make(threadId),
      status,
      providerName: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt,
    },
    createdAt: updatedAt,
  });
}

/** Seed a thread frozen mid-turn the way an ungraceful crash leaves it. */
async function seedCrashedThread(
  system: ReconcilerSystem,
  projectId: string,
  threadId: string,
  turnId: string,
) {
  await seedThread(system, projectId, threadId);
  await setSession(system, threadId, "running", turnId, "2026-01-01T00:00:02.000Z");
}

describe("reconcileInterruptedTurnsOnBoot", () => {
  it("leaves a crashed thread with a running turn / active session (precondition)", async () => {
    const system = await createReconcilerSystem();
    try {
      await seedProject(system, "project-1");
      await seedCrashedThread(system, "project-1", "thread-1", "turn-1");

      const snapshot = await system.readModel();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-1");
      expect(thread?.latestTurn?.state).toBe("running");
      expect(thread?.session?.status).toBe("running");
      expect(thread?.session?.activeTurnId).toBe("turn-1");

      const turn = await system.getTurn("thread-1", "turn-1");
      expect(turn._tag).toBe("Some");
      if (turn._tag === "Some") {
        expect(turn.value.state).toBe("running");
        expect(turn.value.completedAt).toBeNull();
      }
    } finally {
      await system.dispose();
    }
  });

  it("settles a crashed thread to interrupted and stops the session", async () => {
    const system = await createReconcilerSystem();
    try {
      await seedProject(system, "project-1");
      await seedCrashedThread(system, "project-1", "thread-1", "turn-1");

      const result = await system.reconcile();
      expect(result.reconciledCount).toBe(1);

      const snapshot = await system.readModel();
      const thread = snapshot.threads.find((entry) => entry.id === "thread-1");
      expect(thread?.session?.status).toBe("stopped");
      expect(thread?.session?.activeTurnId).toBeNull();

      const turn = await system.getTurn("thread-1", "turn-1");
      expect(turn._tag).toBe("Some");
      if (turn._tag === "Some") {
        expect(turn.value.state).toBe("interrupted");
        expect(turn.value.completedAt).not.toBeNull();
      }
    } finally {
      await system.dispose();
    }
  });

  it("is idempotent: a second boot reconciles nothing and leaves projections unchanged", async () => {
    const system = await createReconcilerSystem();
    try {
      await seedProject(system, "project-1");
      await seedCrashedThread(system, "project-1", "thread-1", "turn-1");

      const first = await system.reconcile();
      expect(first.reconciledCount).toBe(1);

      const eventsAfterFirst = await system.readEvents();
      const snapshotAfterFirst = await system.readModel();

      const second = await system.reconcile();
      expect(second.reconciledCount).toBe(0);

      const eventsAfterSecond = await system.readEvents();
      expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length);

      const snapshotAfterSecond = await system.readModel();
      const threadFirst = snapshotAfterFirst.threads.find((entry) => entry.id === "thread-1");
      const threadSecond = snapshotAfterSecond.threads.find((entry) => entry.id === "thread-1");
      expect(threadSecond?.session?.status).toBe(threadFirst?.session?.status);
      expect(threadSecond?.session?.activeTurnId).toBe(threadFirst?.session?.activeTurnId ?? null);

      const turn = await system.getTurn("thread-1", "turn-1");
      if (turn._tag === "Some") {
        expect(turn.value.state).toBe("interrupted");
      }
    } finally {
      await system.dispose();
    }
  });

  it("only reconciles crashed threads, not already-settled ones (multi-thread selectivity)", async () => {
    const system = await createReconcilerSystem();
    try {
      await seedProject(system, "project-1");
      await seedCrashedThread(system, "project-1", "thread-a", "turn-a");
      await seedCrashedThread(system, "project-1", "thread-b", "turn-b");

      // An already-settled thread: it ran a turn and the session was cleanly stopped.
      await seedThread(system, "project-1", "thread-settled");
      await setSession(system, "thread-settled", "running", "turn-s", "2026-01-01T00:00:03.000Z");
      await setSession(system, "thread-settled", "stopped", null, "2026-01-01T00:00:04.000Z");

      const settledTurnBefore = await system.getTurn("thread-settled", "turn-s");
      expect(settledTurnBefore._tag).toBe("Some");

      const result = await system.reconcile();
      expect(result.reconciledCount).toBe(2);

      const crashedTurns: ReadonlyArray<readonly [string, string]> = [
        ["thread-a", "turn-a"],
        ["thread-b", "turn-b"],
      ];
      for (const [threadId, turnId] of crashedTurns) {
        const turn = await system.getTurn(threadId, turnId);
        if (turn._tag === "Some") {
          expect(turn.value.state).toBe("interrupted");
          expect(turn.value.completedAt).not.toBeNull();
        }
      }

      // The already-settled thread must be untouched (same completedAt).
      const settledTurnAfter = await system.getTurn("thread-settled", "turn-s");
      if (settledTurnBefore._tag === "Some" && settledTurnAfter._tag === "Some") {
        expect(settledTurnAfter.value.state).toBe("interrupted");
        expect(settledTurnAfter.value.completedAt).toBe(settledTurnBefore.value.completedAt);
      }
    } finally {
      await system.dispose();
    }
  });

  it("appends a durable thread.session-set event that survives a projection rebuild", async () => {
    const system = await createReconcilerSystem();
    try {
      await seedProject(system, "project-1");
      await seedCrashedThread(system, "project-1", "thread-1", "turn-1");

      await system.reconcile();

      const events = await system.readEvents();
      const stopEvents = events.filter(
        (event): event is Extract<OrchestrationEvent, { type: "thread.session-set" }> =>
          event.type === "thread.session-set" &&
          event.payload.threadId === "thread-1" &&
          event.payload.session.status === "stopped",
      );
      expect(stopEvents.length).toBe(1);
      const stopEvent = stopEvents[0];
      if (stopEvent) {
        expect(stopEvent.payload.session.activeTurnId).toBeNull();
        expect(String(stopEvent.commandId).startsWith("t3-crash-recovery:")).toBe(true);
      }
    } finally {
      await system.dispose();
    }
  });
});
