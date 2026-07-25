import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

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
  showAttentionNotification,
} from "~/notifications/notifier";
import { useProjects, useThreadShells } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";

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
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const [tracker] = useState(createAttentionTracker);

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

  const deliverEvents = useEffectEvent((events: ReadonlyArray<AttentionEvent>) => {
    if (events.length === 0) {
      return;
    }
    if (!canDeliverNotification(getNotificationPermissionState(), notifyOnNeedsInput)) {
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
