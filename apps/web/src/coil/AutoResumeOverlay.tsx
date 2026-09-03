import { ChevronDownIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Textarea } from "~/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { type AutoResumeThreadRef, httpAutoResumeClient } from "./autoResumeClient";
import { useComposerAnchor } from "./composerAnchor";
import { createAutoResumeController } from "./autoResumeController";
import {
  describeAutoResumeTooltip,
  describePendingReason,
  formatCountdown,
  formatNextAttempt,
} from "./autoResumePresentation";

export type { AutoResumeThreadRef } from "./autoResumeClient";
export { formatAutoResumeStatus } from "./autoResumePresentation";

const POLL_INTERVAL_MS = 30_000;
const COUNTDOWN_TICK_MS = 1_000;

/** Re-renders once a second, but only while a resume is actually scheduled. */
function useCountdownTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [active]);

  return nowMs;
}

export interface SegmentedToggleProps {
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => void;
}

/**
 * `Off | On` as a radiogroup, so auto-resume can be toggled without expanding the panel.
 *
 * A tooltip is not an accessible name, so the group carries `aria-label` in its own right. Roving
 * tabindex keeps the pair to a single tab stop, per the radiogroup pattern.
 */
export function SegmentedToggle({ enabled, onChange }: SegmentedToggleProps) {
  const offRef = useRef<HTMLButtonElement>(null);
  const onRef = useRef<HTMLButtonElement>(null);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      const next = event.key === "ArrowRight";
      onChange(next);
      (next ? onRef : offRef).current?.focus();
    },
    [onChange],
  );

  const segmentClass = (active: boolean) =>
    cn(
      "relative z-10 rounded-full px-2.5 py-0.5 text-center font-medium text-[11px]/4 transition-colors duration-150 hover:cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
      active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      aria-label="Auto-resume"
      className="relative grid grid-cols-2 items-center"
      onKeyDown={handleKeyDown}
      role="radiogroup"
    >
      {/* The fill: ONE element that physically travels between the two segments, so the motion
          reads as a filled region sliding left↔right rather than two backgrounds swapping.

          `cubic-bezier(0.34, 1.56, 0.64, 1)` overshoots slightly and settles — the damping, and it
          is deliberately on the TRAVEL, which is the thing being animated.

          Colour runs for the SAME 320ms so the block stays one object for the whole journey. An
          earlier version resolved colour in 200ms, which finished the blue→grey change while the
          fill was still moving and made it look like the colour flipped rather than the fill
          travelled. Colour uses a plain ease rather than the spring curve because an overshooting
          curve on a colour interpolation drives it past the target and the browser clamps it. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1/2 rounded-full will-change-transform [transition:transform_320ms_cubic-bezier(0.34,1.56,0.64,1),background-color_320ms_ease-out] motion-reduce:transition-none",
          enabled ? "translate-x-full bg-primary" : "translate-x-0 bg-accent",
        )}
      />
      <button
        aria-checked={!enabled}
        className={cn(segmentClass(false), !enabled && "text-foreground")}
        onClick={() => onChange(false)}
        ref={offRef}
        role="radio"
        tabIndex={enabled ? -1 : 0}
        type="button"
      >
        Off
      </button>
      <button
        aria-checked={enabled}
        className={segmentClass(enabled)}
        onClick={() => onChange(true)}
        ref={onRef}
        role="radio"
        tabIndex={enabled ? 0 : -1}
        type="button"
      >
        On
      </button>
    </div>
  );
}

interface AutoResumeOverlayProps {
  readonly threadRef: AutoResumeThreadRef;
}

/**
 * Floating per-thread control for auto-resume (auto-continuing a thread after a usage-limit pause).
 *
 * Anchored bottom-right, sitting immediately above the docked composer and tracking its height, so
 * it reads as belonging to the input rather than floating over the transcript. This also keeps it
 * clear of the toast lane, which is top-anchored: the toast viewport is `fixed z-100` in a portal
 * at body level while this overlay is `z-30` inside `SidebarInset`, so a top-anchored placement
 * could never win on z-index.
 *
 * Renders nothing until the server confirms the feature is reachable for this thread.
 */
export function AutoResumeOverlay({ threadRef }: AutoResumeOverlayProps) {
  const threadId = threadRef.threadId;
  const promptId = useId();
  const [expanded, setExpanded] = useState(false);
  // State rather than a ref: the wrapper only mounts once the server confirms the feature, so the
  // measuring effect has to be re-run when it appears.
  const [anchorElement, setAnchorElement] = useState<HTMLDivElement | null>(null);
  const anchor = useComposerAnchor(anchorElement);

  const controller = useMemo(
    () => createAutoResumeController({ client: httpAutoResumeClient }),
    [],
  );

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    setExpanded(false);
    controller.setThread(threadId);

    const intervalId = window.setInterval(() => controller.refresh(), POLL_INTERVAL_MS);
    const handleFocus = () => controller.refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      // Re-armable teardown: flushes any debounced edit exactly like a dispose would, but survives
      // StrictMode's mount → cleanup → mount cycle, which shares this same memoised controller.
      controller.setThread(null);
    };
  }, [controller, threadId]);

  const state = snapshot.state;
  const pending = state?.pending ?? null;
  const nowMs = useCountdownTick(pending !== null);

  // Entrance transition. The repo has no `tailwindcss-animate` plugin, so `animate-in` utilities
  // are inert here; a mount-state class flip driven by rAF is the portable equivalent, and it
  // re-arms whenever the overlay reappears (thread change, or the route becoming reachable).
  const hasState = state !== null;
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!hasState) {
      setEntered(false);
      return;
    }
    const frameId = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [hasState]);

  if (state === null) {
    return null;
  }

  const tooltip = describeAutoResumeTooltip(state);
  const countdown = pending === null ? null : formatCountdown(pending.resumeAtMs - nowMs);

  return (
    <div
      // Occupies the composer overlay's measured box, then reproduces the composer's own inner
      // layout inside it. That box is NOT the full content width: `chat-composer-horizontal-inset`
      // supplies the outer padding (0.75rem, 1.25rem from 40rem up, plus
      // `env(safe-area-inset-right)`), and inside it the visible card is `mx-auto w-full max-w-3xl`
      // — centred and capped at 768px. Matching only the inset leaves the capsule hanging ~188px
      // past the card on a wide window; matching only `max-w-3xl` drifts once the window is narrow
      // enough for the padding to bite. Both are needed, in this order — and both are only correct
      // while this wrapper spans the same width the composer does, which is why `left`/`width` are
      // measured rather than left to `inset-x-0`.
      //
      // `invisible` rather than unmounting: the effect measures through this element's
      // `offsetParent`, so removing it would strand the capsule with no way to measure its way
      // back. `visibility` also keeps it out of the a11y tree and out of hit-testing.
      className={cn(
        "pointer-events-none chat-composer-horizontal-inset absolute inset-x-0 z-30",
        !anchor.visible && "invisible",
      )}
      ref={setAnchorElement}
      style={{
        bottom: anchor.bottom,
        ...(anchor.left === null ? {} : { left: anchor.left }),
        ...(anchor.width === null ? {} : { width: anchor.width }),
      }}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col-reverse items-end gap-1.5">
        <Collapsible
          className="flex flex-col-reverse items-end gap-1.5"
          onOpenChange={setExpanded}
          open={expanded}
        >
          <div
            className={cn(
              "pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-card p-0.5 pr-1 text-xs shadow-sm transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
              entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <div>
                    <SegmentedToggle enabled={state.enabled} onChange={controller.setEnabled} />
                  </div>
                }
              />
              <TooltipPopup side="top" sideOffset={6}>
                <span className="block font-medium">{tooltip.title}</span>
                <span className="block text-muted-foreground">{tooltip.detail}</span>
              </TooltipPopup>
            </Tooltip>

            <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />

            <CollapsibleTrigger
              aria-label={expanded ? "Hide auto-resume settings" : "Show auto-resume settings"}
              className="flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            >
              {countdown === null ? null : (
                // `font-mono`, not just `tabular-nums`: DM Sans Variable does not ship the `tnum`
                // feature, so `tabular-nums` computes but changes nothing and the digits stay
                // proportional — "5:11:11" measures 36px against "5:00:00" at 60px, which resized
                // the capsule under the cursor every second. JetBrains Mono pins the advance width.
                <span className="font-medium font-mono text-[11px] text-foreground tabular-nums">
                  {countdown}
                </span>
              )}
              <ChevronDownIcon
                className={cn(
                  "size-3 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none",
                  expanded ? "rotate-0" : "rotate-180",
                )}
              />
            </CollapsibleTrigger>
          </div>

          <CollapsiblePanel className="pointer-events-auto">
            <div className="w-72 max-w-full rounded-lg border border-border/60 bg-card p-3 shadow-md">
              <p className="font-medium text-xs">Resume after usage limits</p>

              {pending !== null ? (
                <div className="mt-2 rounded-md border border-primary/20 bg-primary/6 p-2">
                  <p className="font-medium text-xs">
                    Resuming in{" "}
                    <span className="font-mono text-[11px] tabular-nums">{countdown}</span>
                  </p>
                  <p className="mt-0.5 text-[11px]/4 text-muted-foreground">
                    {describePendingReason(pending.reason)} · ~
                    {formatNextAttempt(pending.resumeAtMs)}
                  </p>
                </div>
              ) : null}

              <Textarea
                aria-label="Auto-resume message"
                className="mt-2"
                id={promptId}
                onChange={(event) => controller.setPromptDraft(event.target.value)}
                placeholder="continue"
                size="sm"
                value={snapshot.promptDraft}
              />
              <p className="mt-1.5 text-muted-foreground text-xs">
                Message sent when the thread resumes.
              </p>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
}
