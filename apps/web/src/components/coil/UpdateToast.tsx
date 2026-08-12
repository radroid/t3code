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
import { ChevronDownIcon, ChevronUpIcon, CircleFadingArrowUpIcon } from "lucide-react";
import type { CoilUpdateBridge, CoilUpdateState } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { useThreadShells } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import {
  countProgressingThreads,
  selectUpdateToastView,
  shouldArmAutoRestart,
  shouldAutoRestartNow,
  shouldSendRestart,
  type AutoRestartArmed,
  type UpdateToastView,
} from "./updateToast.logic";

/**
 * How often the armed view re-evaluates its ceiling.
 *
 * The ceiling is two hours, so a minute of slack is invisible to the user and costs one render.
 * Only ticks while something is armed — an idle app should not wake up for this.
 */
const CEILING_TICK_MS = 60_000;

const IDLE_STATE: CoilUpdateState = { status: { kind: "idle" }, hasUpdatedBefore: false };

function updateBridge(): CoilUpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.coilUpdate;
}

/**
 * One toast id for the whole feature.
 *
 * Reusing the id means a build that supersedes another replaces its toast rather than stacking a
 * second one — the user is being offered the newest build, not a queue of them.
 */
type ToastId = ReturnType<typeof toastManager.add>;

export function CoilUpdateToast() {
  const [state, setState] = useState<CoilUpdateState>(IDLE_STATE);
  const [dismissedShortSha, setDismissedShortSha] = useState<string | undefined>(undefined);
  /**
   * Armed state is renderer-local for now, so it does not survive a reload or reach a second
   * window. Moving it to main is the follow-up; keeping it here first means the control is real
   * rather than a button that looks armed and does nothing.
   */
  const [autoRestart, setAutoRestart] = useState<AutoRestartArmed | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const toastId = useRef<ToastId | undefined>(undefined);

  // Only runs while armed: the ceiling has to be able to fire without a user interaction, or the
  // stand-down would wait for a render that never comes.
  useEffect(() => {
    if (autoRestart === undefined) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CEILING_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [autoRestart]);

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
        // Read here rather than inside the selector so the copy stays a pure function of its
        // input, matching `now`.
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
        hasUpdatedBefore: state.hasUpdatedBefore,
        autoRestart,
        now,
      }),
    [state, dismissedShortSha, autoRestart, now],
  );

  // The idle signal. Read unconditionally — hooks cannot be called behind a condition — but only
  // consulted while something is armed.
  const threadShells = useThreadShells();
  const primaryEnvironment = usePrimaryEnvironment();
  const progressingThreadCount = useMemo(
    () => countProgressingThreads(threadShells, primaryEnvironment?.environmentId ?? null),
    [threadShells, primaryEnvironment],
  );

  useEffect(() => {
    if (!shouldAutoRestartNow({ armed: autoRestart, progressingThreadCount, now: Date.now() })) {
      return;
    }
    // Clear the arm before dispatching. `restartNow` tears the app down asynchronously, and a
    // re-render in that window would otherwise fire a second restart at a bundle already being
    // swapped — the exact double-click the main process is single-flight to survive.
    setAutoRestart(undefined);
    void updateBridge()?.restartNow();
  }, [autoRestart, progressingThreadCount]);

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
      onArm: () => {
        if (!shouldArmAutoRestart(view)) return;
        setNow(Date.now());
        setAutoRestart({ armedAt: Date.now() });
      },
      onOpenRun: (url) => {
        // Same path as `desktopUpdate.toast.tsx`: the renderer must not open a browser itself.
        void window.desktopBridge?.openExternal(url);
      },
      onDismiss: (shortSha) => {
        // Dismissing an armed toast cancels the arm. Leaving it armed would restart the app later
        // from a toast the user has already closed — the least expected thing this feature could do.
        setAutoRestart(undefined);
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

/**
 * The build age, pinned to the toast's top-right just inside the close orb.
 *
 * Rendered from `leadingIcon` because that is the only slot whose ReactNode this fork controls that
 * renders inside the card, and `Toast.Root` is positioned, so an absolute child anchors to the card
 * rather than to the icon cell. `right-7` clears the orb, which overhangs the corner.
 *
 * Renders nothing without an age, and renders plain text without a run url — an underlined link
 * that goes nowhere is worse than no link.
 */
function BuiltAgo({
  builtAgo,
  runUrl,
  onOpen,
}: {
  builtAgo: string | undefined;
  runUrl: string | undefined;
  onOpen: (url: string) => void;
}) {
  if (builtAgo === undefined) return null;

  const className = "absolute top-2.5 right-7 text-xs text-muted-foreground/65";
  if (runUrl === undefined) {
    return <span className={className}>built {builtAgo}</span>;
  }

  return (
    <button
      className={`${className} cursor-pointer underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground`}
      onClick={() => {
        onOpen(runUrl);
      }}
      title="Open the workflow run that built this"
      type="button"
    >
      built {builtAgo}
    </button>
  );
}

/**
 * The body: the sentence, then the changelog behind a disclosure.
 *
 * Built here rather than through the toast's `expandableContent`, because that path renders its
 * trigger from `ui/toast.tsx` — a pristine upstream file this fork has never edited, and restyling
 * it there would change every other toast and open a new sync seam for two cosmetic lines.
 *
 * Everything here is phrasing content (spans, a button, svgs). `Toast.Description` renders a `<p>`,
 * so a `<ul>` or `<div>` would be hoisted out by the parser and break the layout.
 */
function UpdateToastBody({
  description,
  changes,
}: {
  description: string;
  changes: readonly string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className="block">{description}</span>
      {/* No disclosure at all when the manifest carried no subjects — an empty "What changed" is a
          promise the toast cannot keep. */}
      {changes.length === 0 ? null : (
        <>
          <button
            aria-expanded={open}
            className="mt-2.5 inline-flex cursor-pointer items-center gap-1 rounded-md text-xs font-medium text-muted-foreground/65 transition-colors hover:text-muted-foreground"
            onClick={() => {
              setOpen((prev) => !prev);
            }}
            type="button"
          >
            {open ? (
              <ChevronUpIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
            ) : (
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-80" strokeWidth={2.25} />
            )}
            {open ? "Hide changes" : "What changed"}
          </button>
          {open ? (
            <span className="mt-2 block max-h-40 overflow-y-auto overscroll-contain">
              {changes.map((change) => (
                <span className="mt-1 flex gap-1.5 text-xs text-muted-foreground/65" key={change}>
                  <span aria-hidden>•</span>
                  <span className="min-w-0 wrap-break-word">{change}</span>
                </span>
              ))}
            </span>
          ) : null}
        </>
      )}
    </>
  );
}

export function toastPayload(
  view: Exclude<UpdateToastView, { kind: "hidden" }>,
  handlers: {
    readonly onRestart: () => void;
    readonly onArm: () => void;
    readonly onOpenRun: (url: string) => void;
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
      // `pr-24` reserves the corner the build age occupies, so a longer title wraps instead of
      // running underneath it.
      title: <span className="block pr-24">{view.title}</span>,
      description: <UpdateToastBody description={view.description} changes={view.changes} />,
      timeout: 0,
      actionProps: { children: view.actionLabel, onClick: handlers.onRestart },
      actionVariant: "default",
      data: {
        hideCopyButton: true,
        leadingIcon: (
          <>
            <CircleFadingArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />
            <BuiltAgo builtAgo={view.builtAgo} onOpen={handlers.onOpenRun} runUrl={view.runUrl} />
          </>
        ),
        // The arm control. Ghost rather than a second filled button: restarting now is still the
        // primary path, and two equally-weighted buttons make the user choose before reading.
        secondaryActionProps: { children: view.autoRestartLabel, onClick: handlers.onArm },
        secondaryActionVariant: "ghost",
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

  // Confirmation that the install landed. Handled explicitly for the same reason `armed` is: the
  // fallthrough below renders an ERROR toast, so a successful update would announce itself as a
  // failure — the exact inversion this state exists to prevent.
  if (view.kind === "updated") {
    return {
      type: "success" as const,
      title: view.title,
      description: view.description,
      timeout: 0,
      actionProps: undefined,
      data: { hideCopyButton: true },
    };
  }

  // The app came back as a different build than it restarted to install. The report button is the
  // whole point of the state: without it this is a dead-end error the user can only screenshot.
  if (view.kind === "install-failed") {
    return {
      type: "error" as const,
      title: view.title,
      description: view.description,
      timeout: 0,
      // Opens a PRE-FILLED issue form for review. Nothing is filed on the user's behalf — the repo
      // is public, and posting from their account without showing them the text is not undoable.
      actionProps: {
        children: view.reportLabel,
        onClick: () => {
          handlers.onOpenRun(view.reportUrl);
        },
      },
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
