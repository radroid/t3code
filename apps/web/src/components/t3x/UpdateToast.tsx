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

import { useEffect, useMemo, useRef, useState } from "react";
import type { T3xUpdateBridge, T3xUpdateState } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  selectUpdateToastView,
  shouldSendRestart,
  type UpdateToastView,
} from "./updateToast.logic";

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

  const view = useMemo(
    () =>
      selectUpdateToastView({
        status: state.status,
        dismissedShortSha,
        isElectron: updateBridge() !== undefined,
        hasUpdatedBefore: state.hasUpdatedBefore,
      }),
    [state, dismissedShortSha],
  );

  // Keyed on the view's content, not its identity. `selectUpdateToastView` returns a fresh object
  // every render, so depending on the object itself would push a toast update on every re-render
  // of the root route — which is most of them.
  const viewKey = JSON.stringify(view);

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
  }, [viewKey]);

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
  //
  // Built through `stackedThreadToast` rather than by hand: `actionVariant` and `onClose` are read
  // off `toast.data`, not off the top level, so passing them directly is accepted by the types and
  // then ignored at render — the dismiss would never register and the button would render with the
  // wrong variant.
  if (view.kind === "ready") {
    return stackedThreadToast({
      type: "info",
      title: view.title,
      description: view.description,
      timeout: 0,
      actionProps: { children: view.actionLabel, onClick: handlers.onRestart },
      actionVariant: "default",
      data: {
        hideCopyButton: true,
        onClose: () => {
          handlers.onDismiss(view.shortSha);
        },
      },
    });
  }

  // Armed auto-restart. Handled explicitly rather than falling through: the `return` at the bottom
  // of this function renders as an ERROR toast, so an unhandled state does not merely look wrong,
  // it tells the user the update failed when it is in fact waiting for them to finish.
  if (view.kind === "armed") {
    return stackedThreadToast({
      type: "info",
      title: view.title,
      description: view.description,
      timeout: 0,
      actionProps: { children: view.actionLabel, onClick: handlers.onRestart },
      actionVariant: "default",
      data: {
        hideCopyButton: true,
        onClose: () => {
          handlers.onDismiss(view.shortSha);
        },
      },
    });
  }

  if (view.kind === "restarting") {
    return {
      type: "loading" as const,
      title: view.title,
      timeout: 0,
      // Cleared explicitly: leaving the Restart button visible during the restart invites a second
      // click on a bundle that is already being swapped. Base UI merges updates into the existing
      // toast, so an omitted `actionProps` would leave the old button in place.
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
