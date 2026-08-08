/**
 * TEMPORARY design harness — not part of the shipped build.
 *
 * Renders candidate looks/copy for the fork's update toast on top of the real app, so variants can
 * be compared in situ instead of in a storybook that does not have the app's glass, spacing or
 * sidebar behind it. Drive it with `?toastvariant=<id>` on any route.
 *
 * Delete this file (and its mount in `__root.tsx`) once a variant is chosen.
 */

import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleArrowUpIcon,
  CircleFadingArrowUpIcon,
  RocketIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { stackedThreadToast, toastManager } from "../ui/toast";
import { toastPayload } from "./UpdateToast";
import {
  selectUpdateToastView,
  type AutoRestartArmed,
  type UpdateToastInput,
} from "./updateToast.logic";

const SHA = "3f2a1b9c4e7d";
const SHORT_SHA = "3f2a1b9c";

/** The SHA as a chip rather than prose: scannable, and it stops the hex from leading the sentence. */
function Sha({ value = SHORT_SHA }: { value?: string }) {
  return (
    <span className="rounded border border-border/60 bg-muted/60 px-1 py-px font-mono text-[10.5px] tracking-tight text-muted-foreground">
      {value}
    </span>
  );
}

function ChangeList({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li className="flex gap-1.5 text-xs text-muted-foreground" key={item}>
          <span aria-hidden className="text-muted-foreground/50">
            •
          </span>
          <span className="min-w-0 wrap-break-word">{item}</span>
        </li>
      ))}
    </ul>
  );
}

const CHANGES = [
  "Steer a running turn instead of queuing behind it",
  "Keep the queue's reorder controls usable",
  "Follow the 302 on GitHub release asset downloads",
] as const;

const PERMISSION_NOTE =
  "These builds are ad-hoc signed, so macOS sees a new app identity each time and asks for screen-recording and automation access again.";

/**
 * The chosen design: V4's changelog body, V3's icon and build age.
 *
 * The disclosure is built here rather than through the toast's `expandableContent`, because that
 * path renders its trigger from `ui/toast.tsx` — a pristine upstream file this fork has never
 * edited, and restyling it there would change every other toast and open a new sync seam for two
 * cosmetic lines.
 *
 * Everything below is phrasing content (spans, a button, svgs). `Toast.Description` renders a `<p>`,
 * so a `<ul>`/`<div>` here would be hoisted out by the parser and break the layout.
 */
function UpdateToastBody({ changes }: { changes: readonly string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span className="block">Restart to update T3 Code.</span>
      <button
        aria-expanded={open}
        // `mt-2.5` is the requested breathing room between the sentence and the disclosure.
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
            // Same `/65` as the toggle: the disclosure reads as one recessive block rather than a
            // label and a brighter list competing for the eye.
            <span className="mt-1 flex gap-1.5 text-xs text-muted-foreground/65" key={change}>
              <span aria-hidden>•</span>
              <span className="min-w-0 wrap-break-word">{change}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

type Variant = { readonly label: string; readonly payload: () => unknown };

const VARIANTS: Record<string, Variant> = {
  /** FINAL — V4's structure, V3's icon + build age, lighter disclosure, extra gap above it. */
  final: {
    label: "FINAL (V4 + V3 icon/age)",
    payload: () =>
      stackedThreadToast({
        type: "info",
        // `pr-24` reserves the corner the age occupies. Without it a longer title ("12 changes
        // ready to run") would run underneath the absolutely-positioned age instead of wrapping.
        title: <span className="block pr-24">3 changes ready to run</span>,
        description: <UpdateToastBody changes={CHANGES} />,
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          // The age is pinned to the toast's top-right, just inside the close orb. `leadingIcon` is
          // the only slot whose ReactNode this fork controls that renders inside the card, and
          // `Toast.Root` is positioned, so an absolute child anchors to the card rather than the
          // icon cell. `right-7` clears the orb, which overhangs the corner at `-right-1.5`.
          leadingIcon: (
            <>
              <CircleFadingArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />
              <button
                className="absolute top-2.5 right-7 cursor-pointer text-xs text-muted-foreground/65 underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
                onClick={() => {
                  // Real impl goes through `shell.openExternal` like `desktopUpdate.toast.tsx`;
                  // `window.open` is only so the preview is clickable in a browser tab.
                  window.open("https://github.com/radroid/t3code/actions", "_blank");
                }}
                title="Open the workflow run that built this"
                type="button"
              >
                built 4 min ago
              </button>
            </>
          ),
          secondaryActionProps: { children: "Later" },
          secondaryActionVariant: "ghost",
        },
      }),
  },

  // ---------------------------------------------------------------- READY state

  /** V1 — what ships today, for side-by-side comparison. */
  "1": {
    label: "Baseline (current)",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Update ready",
        description: `Build ${SHORT_SHA} is staged and will apply on restart.`,
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: { hideCopyButton: true },
      }),
  },

  /** V2 — calm minimal. Drops the SHA from the primary read; the sentence is the whole message. */
  "2": {
    label: "Calm minimal",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Update ready",
        description: "Restart to run the new build. Takes a few seconds.",
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <CircleArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />,
        },
      }),
  },

  /** V3 — provenance. Keeps the build identity but demotes it to a chip plus a relative time. */
  "3": {
    label: "Provenance chip",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "New build ready",
        description: (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            Restart to apply. <Sha />
            <span className="text-muted-foreground/70">built 4 min ago</span>
          </span>
        ),
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <CircleFadingArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />,
        },
      }),
  },

  /** V4 — changelog-forward. On a fork you maintain, "what did I merge" is the real question. */
  "4": {
    label: "Changelog-forward",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "3 changes ready to run",
        description: "Restart to update T3 Code.",
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <SparklesIcon className="size-4 text-info" strokeWidth={2.25} />,
          expandableContent: <ChangeList items={CHANGES} />,
          expandableLabels: { expand: "What changed", collapse: "Hide changes" },
          secondaryActionProps: { children: "Later" },
          secondaryActionVariant: "ghost",
        },
      }),
  },

  /** V5 — action-forward. The title is the instruction; the body only reassures. */
  "5": {
    label: "Action-forward",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Restart to update",
        description: "The new build is downloaded and ready to go.",
        timeout: 0,
        actionProps: { children: "Restart now" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <RocketIcon className="size-4 text-info" strokeWidth={2.25} />,
        },
      }),
  },

  /** V6 — fork voice. Frames the update as the user's own merge landing, not a vendor push. */
  "6": {
    label: "Fork voice",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Your latest changes are ready",
        description: (
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            Restart to run <Sha />
          </span>
        ),
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <CircleArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />,
        },
      }),
  },

  // ------------------------------------------------- FIRST-UPDATE permission note

  /** V7a — today's treatment: the note is appended to the description as one long sentence. */
  "7a": {
    label: "First update — inline note (current)",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Update ready",
        description: `Build ${SHORT_SHA} is staged and will apply on restart. Because these builds are unsigned, macOS will ask for screen-recording and automation permissions again after restarting.`,
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: { hideCopyButton: true },
      }),
  },

  /** V7b — the note moved behind a disclosure, so the toast stays one line until asked. */
  "7b": {
    label: "First update — disclosed note",
    payload: () =>
      stackedThreadToast({
        type: "info",
        title: "Update ready",
        description: "Restart to run the new build. Takes a few seconds.",
        timeout: 0,
        actionProps: { children: "Restart" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          leadingIcon: <CircleArrowUpIcon className="size-4 text-info" strokeWidth={2.25} />,
          expandableContent: (
            <p className="flex gap-1.5 text-xs text-muted-foreground">
              <TriangleAlertIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-warning"
                strokeWidth={2.25}
              />
              <span>{PERMISSION_NOTE}</span>
            </p>
          ),
          expandableLabels: {
            expand: "macOS will ask for permissions again",
            collapse: "Hide",
          },
        },
      }),
  },

  // ------------------------------------------------------------ RESTARTING state

  "8a": {
    label: "Restarting (current)",
    payload: () => ({
      type: "loading" as const,
      title: "Restarting…",
      timeout: 0,
      actionProps: undefined,
      data: { hideCopyButton: true },
    }),
  },

  "8b": {
    label: "Restarting — reassuring",
    payload: () => ({
      type: "loading" as const,
      title: "Installing update…",
      description: "T3 Code will reopen in a moment. Your work is saved.",
      timeout: 0,
      actionProps: undefined,
      data: { hideCopyButton: true },
    }),
  },

  // ---------------------------------------------------------------- FAILED state

  "9a": {
    label: "Failed (current)",
    payload: () => ({
      type: "error" as const,
      title: "Update failed",
      description:
        "The staged build could not be swapped in. Details: /Users/you/Library/Logs/T3 Code/update.log",
      timeout: 0,
      actionProps: undefined,
      data: { hideCopyButton: true },
    }),
  },

  /** V9b — the log path becomes a button; a dead end becomes two next steps. */
  "9b": {
    label: "Failed — actionable",
    payload: () =>
      stackedThreadToast({
        type: "error",
        title: "Couldn't install the update",
        description: "The staged build could not be swapped in. You're still on the old build.",
        timeout: 0,
        actionProps: { children: "Try again" },
        actionVariant: "default",
        data: {
          hideCopyButton: true,
          secondaryActionProps: { children: "Open log" },
          secondaryActionVariant: "outline",
        },
      }),
  },
};

/**
 * Drives the SHIPPING logic and payload builder, not a mock of them.
 *
 * `selectUpdateToastView` + `toastPayload` are the real functions `T3xUpdateToast` uses; only the
 * delivery status and the clock are faked, because a browser tab has no `desktopBridge` and there
 * is no staged bundle to restart into. Clicking "Restart when idle" therefore exercises the actual
 * state machine — the toast that comes back is the one a packaged build would show.
 */
function mountLiveDemo(): void {
  let armed: AutoRestartArmed | undefined;
  let id: ReturnType<typeof toastManager.add> | undefined;
  // Offset rather than a real clock, so the ceiling can be reached without waiting two hours.
  let clockOffsetMs = 0;

  const render = (): void => {
    const input: UpdateToastInput = {
      status: {
        kind: "ready",
        shortSha: "3f2a1b9c4e7d",
        version: "0.0.31-t3x.44",
        changes: [...CHANGES],
        builtAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        runUrl: "https://github.com/radroid/t3code/actions",
      },
      dismissedShortSha: undefined,
      isElectron: true,
      hasUpdatedBefore: true,
      autoRestart: armed,
      now: Date.now() + clockOffsetMs,
    };

    const view = selectUpdateToastView(input);
    if (view.kind === "hidden") {
      if (id !== undefined) toastManager.close(id);
      id = undefined;
      return;
    }

    const payload = toastPayload(view, {
      onRestart: () => {
        console.info("[toastpreview] restartNow() — no bundle to swap in a browser tab");
      },
      onArm: () => {
        armed = { armedAt: Date.now() + clockOffsetMs };
        render();
      },
      onOpenRun: (url) => {
        window.open(url, "_blank");
      },
      onDismiss: () => {
        armed = undefined;
        if (id !== undefined) toastManager.close(id);
        id = undefined;
      },
    });

    if (id === undefined) {
      id = toastManager.add(payload as never);
    } else {
      toastManager.update(id, payload as never);
    }
  };

  // Jump the clock past the two-hour ceiling to see the stand-down without waiting for it.
  (window as unknown as Record<string, unknown>).__toastExpire = () => {
    clockOffsetMs += 2 * 60 * 60 * 1000 + 1000;
    render();
    return "ceiling reached";
  };

  render();
}

export function T3xUpdateToastVariantsPreview() {
  useEffect(() => {
    let current: ReturnType<typeof toastManager.add> | undefined;

    // Exposed as a global rather than driven off mount: the harness needs to fire *after* the app
    // has settled, and needs to swap variants without a reload so the backdrop stays identical
    // between shots.
    (window as unknown as Record<string, unknown>).__toastPreview = (id: string) => {
      if (current !== undefined) toastManager.close(current);
      if (id === "live") {
        mountLiveDemo();
        return "Live (real logic + real payload)";
      }
      const variant = VARIANTS[id];
      if (variant === undefined) {
        console.warn("[toastpreview] unknown variant", id, Object.keys(VARIANTS));
        return "unknown";
      }
      current = toastManager.add(variant.payload() as never);
      return variant.label;
    };
    console.info("[toastpreview] ready", Object.keys(VARIANTS).join(","));

    // Deliberately delayed: the app's startup remounts the provider tree once auth settles, which
    // drops anything queued during the first paint. 1.2s clears it comfortably.
    const requested = new URLSearchParams(window.location.search).get("toastvariant");
    if (requested === null) return;
    const timer = setTimeout(() => {
      (window as unknown as { __toastPreview: (id: string) => string }).__toastPreview(requested);
    }, 1200);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return null;
}
