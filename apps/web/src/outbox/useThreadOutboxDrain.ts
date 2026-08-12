import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import { CommandId, type EnvironmentId, type MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  ensureThreadOutboxLoaded,
  removeThreadOutboxMessage,
  useThreadOutboxEditingIds,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./threadOutbox";
import {
  modelSelectionsEqual,
  resolveQueuedThreadSettings,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./threadOutbox.logic";

/**
 * While messages are queued, re-run the drain on this cadence so the time-based
 * idle-gate (`canSettle`, whose queued-turn-start grace window opens purely by
 * elapsed time with no atom change to signal it) is re-evaluated instead of a
 * head stalling until some unrelated re-render happens to fire.
 */
const THREAD_OUTBOX_DRAIN_HEARTBEAT_MS = 5_000;

/**
 * The drain engine, ported from apps/mobile/src/state/use-thread-outbox-drain.ts.
 *
 * A single global in-flight lock, picks the first eligible head per thread,
 * sends one-at-a-time, removes on success, retries transient failures with
 * backoff and discards deterministic ones. The "idle" gate reuses the
 * client-runtime `canSettle` predicate so a just-adopted turn (still invisible
 * to session status) can never trigger a double send.
 */
export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useThreadOutboxEditingIds();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    void ensureThreadOutboxLoaded();
    const timers = retryTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  const makeDeliveryHelpers = useCallback((queuedMessage: QueuedThreadMessage) => {
    const reportFailure = (
      commandResult: AtomCommandResult<unknown, unknown>,
      stage: ThreadOutboxCommandStage,
    ): boolean => {
      if (!AsyncResult.isFailure(commandResult)) {
        return false;
      }
      const action = resolveThreadOutboxFailureAction({
        stage,
        error: Cause.squash(commandResult.cause),
        interrupted: Cause.hasInterruptsOnly(commandResult.cause),
      });
      const retry = action === "retry";
      console.warn("[thread-outbox] queued message delivery failed", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
        stage,
        cause: commandResult.cause,
        retry,
      });
      return retry;
    };
    const completeDelivery = async (
      deliveryResult: AtomCommandResult<unknown, unknown>,
    ): Promise<boolean> => {
      if (reportFailure(deliveryResult, "start-turn")) {
        return false;
      }

      try {
        await removeThreadOutboxMessage(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    };
    return { reportFailure, completeDelivery };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const settings = resolveQueuedThreadSettings(queuedMessage, thread);
      const { reportFailure, completeDelivery } = makeDeliveryHelpers(queuedMessage);
      // Stamped at DISPATCH, not carried over from enqueue (radroid/t3code#40 A1+A2).
      // This is what upstream's immediate-send path does, and shipping the enqueue
      // time instead broke two things at once:
      //
      //  * the snapshot sorts `ORDER BY thread_id, created_at ASC, message_id`, so a
      //    reordered queue delivered rows in the new order and rebuilt the transcript
      //    in the old one. Invisible live (the reducer appends in arrival order) and
      //    permanent from the first reload, reconnect resync, or thread reopen.
      //  * `hasQueuedTurnStart` only recognises an unadopted turn start within
      //    `QUEUED_TURN_START_GRACE_MS` (2 min) of the message time. A message that
      //    waited longer than that — the normal case for a queued one — arrived with
      //    the anti-double-send gate already expired, so `canSettle` read the thread
      //    as settleable and a second `turn/start` could go out. On Codex that
      //    orphans the first turn's events.
      //
      // The queue's own `queuedMessage.createdAt` is untouched; it still orders the
      // queue list (`threadOutbox.logic.ts` `sortKey ?? createdAt`).
      const dispatchedAt = new Date().toISOString();

      if (!modelSelectionsEqual(settings.modelSelection, thread.modelSelection)) {
        const updateResult = await updateThreadMetadata({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "model-selection"),
            threadId: queuedMessage.threadId,
            modelSelection: settings.modelSelection,
          },
        });
        if (AsyncResult.isFailure(updateResult)) {
          reportFailure(updateResult, "settings-sync");
          return false;
        }
      }

      if (settings.runtimeMode !== thread.runtimeMode) {
        const runtimeResult = await setThreadRuntimeMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "runtime-mode"),
            threadId: queuedMessage.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt: dispatchedAt,
          },
        });
        if (AsyncResult.isFailure(runtimeResult)) {
          reportFailure(runtimeResult, "settings-sync");
          return false;
        }
      }

      if (settings.interactionMode !== thread.interactionMode) {
        const interactionResult = await setThreadInteractionMode({
          environmentId: queuedMessage.environmentId,
          input: {
            commandId: settingsCommandId(queuedMessage, "interaction-mode"),
            threadId: queuedMessage.threadId,
            interactionMode: settings.interactionMode,
            createdAt: dispatchedAt,
          },
        });
        if (AsyncResult.isFailure(interactionResult)) {
          reportFailure(interactionResult, "settings-sync");
          return false;
        }
      }

      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: [],
          },
          modelSelection: settings.modelSelection,
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt: dispatchedAt,
        },
      });
      return completeDelivery(deliveryResult);
    },
    [
      makeDeliveryHelpers,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      startTurn,
      updateThreadMetadata,
    ],
  );

  // Heartbeat: the `canSettle` gate can hinge on elapsed time alone, which no
  // dependency below changes. While anything is queued, tick periodically so a
  // head held back only by that time-gate is delivered promptly once its grace
  // window elapses, rather than waiting for an incidental state change.
  useEffect(() => {
    const hasQueued = Object.values(queuedMessagesByThreadKey).some((queue) => queue.length > 0);
    if (!hasQueued) {
      return;
    }
    const interval = setInterval(() => {
      setRetryTick((current) => current + 1);
    }, THREAD_OUTBOX_DRAIN_HEARTBEAT_MS);
    return () => {
      clearInterval(interval);
    };
  }, [queuedMessagesByThreadKey]);

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    const connectedEnvironmentIds = new Set<EnvironmentId>(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    );
    const nowIso = new Date().toISOString();

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if (editingQueuedMessageIds[nextQueuedMessage.messageId]) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (
        thread &&
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) !== threadKey
      ) {
        continue;
      }

      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: connectedEnvironmentIds.has(nextQueuedMessage.environmentId),
        threadBusy: thread !== undefined ? !canSettle(thread, { now: nowIso }) : true,
      });
      if (deliveryAction === "wait") {
        continue;
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId: nextQueuedMessage.messageId,
              error,
            });
            return false;
          },
        );
      const delivery =
        deliveryAction === "remove"
          ? removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : thread !== undefined
            ? sendQueuedMessage(nextQueuedMessage, thread)
            : Promise.resolve(false);
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    environments,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}

/** Mounted once (near NotificationCoordinator) to run the drain for the app. */
export function ThreadOutboxDrain(): null {
  useThreadOutboxDrain();
  return null;
}
