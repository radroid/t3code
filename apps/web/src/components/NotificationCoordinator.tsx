import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useClientSettings } from "~/hooks/useSettings";
import {
  buildAwarenessInputs,
  resolveActivationRouteParams,
} from "~/notifications/coordinator.logic";
import {
  createAttentionTracker,
  shouldSuppressAttentionEvent,
  type AttentionEvent,
} from "~/notifications/needsAttention.logic";
import {
  canDeliverNotification,
  getNotificationPermissionState,
  requestWebNotificationPermission,
  showAttentionNotification,
  type WebNotificationPermission,
} from "~/notifications/notifier";
import {
  shouldShowPermissionPrompt,
  type PermissionPromptState,
} from "~/notifications/permissionPrompt.logic";
import { useProjects, useThreadShells } from "~/state/entities";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "~/threadRoutes";

/**
 * Announces chats that start waiting on the user, on desktop through the OS
 * notification bridge and in the browser through the Web Notification API.
 *
 * The tracker is fed on every shell change regardless of the user's setting or
 * the permission state: it edge-detects phase transitions, so skipping updates
 * would leave it holding stale phases and replay old transitions the moment
 * notifications are enabled.
 */
export function NotificationCoordinator() {
  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const projects = useProjects();
  const notifyOnNeedsInput = useClientSettings((settings) => settings.notifyOnNeedsInput);
  // Resolved through the draft route too: right after a draft is promoted the
  // user is still on `/draft/$draftId`, and the chat they are looking at must
  // stay suppressed.
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const [tracker] = useState(createAttentionTracker);
  const promptStateRef = useRef<PermissionPromptState>({ promptedThisSession: false });

  const handleActivation = useCallback(
    (activation: { readonly environmentId: string; readonly threadId: string }) => {
      const params = resolveActivationRouteParams(activation);
      if (!params) {
        return;
      }
      void navigate({ to: "/$environmentId/$threadId", params });
    },
    [navigate],
  );

  /**
   * Nudges a browser that has never answered the permission dialog, at the one
   * moment the ask is self-explanatory: a chat just started waiting. Marked as
   * prompted before the toast is even answered, so an ignored or declined
   * prompt is not repeated for the rest of the session.
   */
  const promptForPermission = useEffectEvent((permission: WebNotificationPermission) => {
    if (
      !shouldShowPermissionPrompt({
        state: promptStateRef.current,
        settingEnabled: notifyOnNeedsInput,
        permission,
        isElectron,
      })
    ) {
      return;
    }
    promptStateRef.current = { promptedThisSession: true };
    toastManager.add({
      type: "info",
      title: "Enable notifications to know when an agent needs you.",
      actionProps: {
        children: "Enable",
        onClick: () => {
          void requestWebNotificationPermission().catch(() => undefined);
        },
      },
    });
  });

  const deliverEvents = useEffectEvent((events: ReadonlyArray<AttentionEvent>) => {
    if (events.length === 0) {
      return;
    }
    const permission = getNotificationPermissionState();
    if (!canDeliverNotification(permission, notifyOnNeedsInput)) {
      // Dropped events are the cue for the contextual prompt: the only
      // recoverable reason is a permission the user has yet to answer.
      promptForPermission(permission);
      return;
    }

    const view = {
      hasFocus: document.hasFocus(),
      visible: document.visibilityState === "visible",
      activeEnvironmentId: routeThreadRef?.environmentId ?? null,
      activeThreadId: routeThreadRef?.threadId ?? null,
    };

    for (const event of events) {
      if (shouldSuppressAttentionEvent(event, view)) {
        continue;
      }
      showAttentionNotification(event, handleActivation);
    }
  });

  useEffect(() => {
    deliverEvents(tracker.update(buildAwarenessInputs(threadShells, projects)));
  }, [projects, threadShells, tracker]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onNotificationActivated) {
      return;
    }
    return bridge.onNotificationActivated(handleActivation);
  }, [handleActivation]);

  return null;
}
