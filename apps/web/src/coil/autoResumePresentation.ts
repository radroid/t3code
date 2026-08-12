/**
 * Pure presentation helpers for the auto-resume overlay.
 *
 * Deliberately free of React and of `Date.now()` — every function takes the values it needs, so
 * the copy shown for each state is pinned by tests rather than by screenshotting the app.
 *
 * @module coil/autoResumePresentation
 */

import type { AutoResumeState } from "./autoResumeClient";

const nextAttemptFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function formatNextAttempt(resumeAtMs: number): string {
  return nextAttemptFormatter.format(new Date(resumeAtMs));
}

export function formatAutoResumeStatus(state: AutoResumeState): string {
  if (!state.enabled) {
    return "Auto-resume: off";
  }
  if (state.pending === null) {
    return "Auto-resume: on";
  }
  return `Auto-resume: on · next attempt ~${formatNextAttempt(state.pending.resumeAtMs)}`;
}

/**
 * `mm:ss`, or `h:mm:ss` past an hour. Clamped at zero: the reactor fires on its own schedule, so a
 * countdown that has run out means "any moment now", never a negative number.
 *
 * **Minutes are zero-padded so the string length never changes.** `tabular-nums` at the call site
 * equalises digit *widths*, but it cannot help when the character *count* drops — `10:00` → `9:59`
 * loses a character and visibly resizes the capsule mid-hover. Padding pins sub-hour countdowns at
 * exactly five characters, so the only width change in the control's whole life is the one-time
 * `1:00:00` → `59:59` step.
 */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const paddedSeconds = String(seconds).padStart(2, "0");
  const paddedMinutes = String(minutes).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  }
  return `${paddedMinutes}:${paddedSeconds}`;
}

export interface AutoResumeTooltipCopy {
  readonly title: string;
  readonly detail: string;
}

/**
 * The capsule shows `Off | On` plus a bare countdown, which drops the wording and the absolute
 * time. The tooltip is where both come back — hence a fixed title and a state-dependent detail.
 */
export function describeAutoResumeTooltip(state: AutoResumeState): AutoResumeTooltipCopy {
  if (!state.enabled) {
    return { title: "Auto-resume", detail: "Off for this thread" };
  }
  if (state.pending === null) {
    return { title: "Auto-resume", detail: "On · nothing scheduled" };
  }
  return {
    title: "Auto-resume",
    detail: `Next attempt ~${formatNextAttempt(state.pending.resumeAtMs)}`,
  };
}

/** Copy for the pending block inside the expanded panel. */
export function describePendingReason(reason: string): string {
  return reason === "" ? "Paused" : `Paused: ${reason}`;
}
