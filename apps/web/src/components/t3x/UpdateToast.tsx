/**
 * The fork's update toast.
 *
 * Renders nothing itself — it drives `toastManager`, like every other notification in this app, so
 * the update lands in the same stack the user already reads instead of inventing a second place to
 * look. All of the decisions about *what* to show live in `updateToast.logic.ts`; this file is the
 * subscription and the toast calls.
 *
 * There is exactly one update surface in a fork build. Upstream's two — the sidebar pill and
 * `desktopUpdate.toast.tsx` — are both silenced by building with `GITHUB_REPOSITORY: ""`, which
 * packages no `app-update.yml`, which makes electron-updater self-disable. See the design doc.
 */

import { useEffect, useRef, useState } from "react";
import type { T3xUpdateBridge, T3xUpdateState } from "@t3tools/contracts";

import { toastManager } from "../ui/toast";
import { selectUpdateToastView, shouldSendRestart, type UpdateToastView } from "./updateToast.logic";

const IDLE_STATE: T3xUpdateState = { status: { kind: "idle" }, hasUpdatedBefore: false };

function updateBridge(): T3xUpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.t3xUpdate;
}

/**
 * One toast id for the whole feature.
 *
 * Reusing the id means a build that supersedes another replaces its toast rather than stacking a
 * second one — the user is being offered the newest build, not a queue of them.
 */
type ToastId = ReturnType<typeof toastManager.add>;

export function T3xUpdateToast() {
  const [state, setState] = useState<T3xUpdateState>(IDLE_STATE);
  const [dismissedShortSha, setDismissedShortSha] = useState<string | undefined>(undefined);
  const toastId = useRef<ToastId | undefined>(undefined);

  useEffect(() => {
    const bridge = updateBridge();
    if (bridge === undefined) return;

    let cancelled = false;
    // Read once as well as subscribing: the main process may already be holding a ready build from
    // before this window existed, and a subscription alone would only see the NEXT change — which
    // for an app that updates on merge could be hours away.
    void bridge
      .getState()
      .then((initial) => {
        if (!cancelled) setState(initial);
      })
      .catch(() => {
        // An older desktop shell hosting this bundle. Staying idle is the correct fallback.
      });

    const unsubscribe = bridge.onState((next) => {
      setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const view = selectUpdateToastView({
    status: state.status,
    dismissedShortSha,
    isElectron: updateBridge() !== undefined,
    hasUpdatedBefore: state.hasUpdatedBefore,
  });

  useEffect(() => {
    if (view.kind === "hidden") {
      if (toastId.current !== undefined) {
        toastManager.close(toastId.current);
        toastId.current = undefined;
      }
      return;
    }

    const payload = toastPayload(view, {
      onRestart: () => {
        if (!shouldSendRestart(view)) return;
        void updateBridge()?.restartNow();
      },
      onDismiss: (shortSha) => {
        setDismissedShortSha(shortSha);
        // Told to the main process too, so a second window does not immediately re-raise the toast
        // this one just closed.
        void updateBridge()?.dismiss(shortSha);
      },
    });

    if (toastId.current === undefined) {
      toastId.current = toastManager.add(payload);
    } else {
      toastManager.update(toastId.current, payload);
    }
  }, [view]);

  return null;
}

function toastPayload(
  view: Exclude<UpdateToastView, { kind: "hidden" }>,
  handlers: {
    readonly onRestart: () => void;
    readonly onDismiss: (shortSha: string) => void;
  },
) {
  // `timeout: 0` on every variant. An update that quietly times out is an update the user never
  // learns about, and a failure that times out is issue #41's silence all over again.
  if (view.kind === "ready") {
    return {
      type: "info" as const,
      title: view.title,
      description: view.description,
      timeout: 0,
      actionProps: { children: view.actionLabel, onClick: handlers.onRestart },
      actionVariant: "default" as const,
      data: { hideCopyButton: true },
      onClose: () => {
        handlers.onDismiss(view.shortSha);
      },
    };
  }

  if (view.kind === "restarting") {
    return {
      type: "loading" as const,
      title: view.title,
      timeout: 0,
      // Cleared explicitly: leaving the Restart button visible during the restart invites a second
      // click on a bundle that is already being swapped.
      actionProps: undefined,
      data: { hideCopyButton: true },
    };
  }

  return {
    type: "error" as const,
    title: view.title,
    description: view.description,
    timeout: 0,
    actionProps: undefined,
    data: { hideCopyButton: true },
  };
}
