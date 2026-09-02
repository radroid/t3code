/**
 * Pure presentation helpers for the loop console and the Loops settings panel.
 *
 * Deliberately free of React and of `Date.now()` — every function takes the values it needs, so
 * the copy shown for each state is pinned by tests rather than by screenshotting the app. The two
 * rules this module exists to enforce are both here rather than in JSX, for exactly that reason:
 *
 * **`spent` is never rendered as success.** "It finished" and "it ran out of rope" are different
 * outcomes, and conflating them is the failure this feature is built to stop. `done` is the only
 * emerald tone in the file.
 *
 * **A missing question channel is never rendered as "no questions".** The MCP credential that
 * backs `raise_blocker` is minted only when agent browser access is on, so with it off the console
 * would otherwise show an empty blocker list — which reads as "nothing to ask about" and is the
 * precise failure the deferred channel exists to prevent.
 *
 * @module coil/loop/loopPresentation
 */

import type {
  LoopBlocker,
  LoopCheckInRow,
  LoopDerived,
  LoopSettings,
  LoopStopReason,
  LoopUserInput,
  LoopView,
} from "./loopClient";

/**
 * Colour families the console uses, resolved to theme tokens at the call site.
 *
 * `spent` is its own tone rather than a variant of `done` so that no styling change can ever make
 * an exhausted run look finished.
 */
export type LoopTone = "muted" | "active" | "attention" | "held" | "done" | "spent";

export interface LoopStateCopy {
  readonly label: string;
  readonly tone: LoopTone;
  /** One sentence saying what that state actually means for the human reading it. */
  readonly detail: string;
}

const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** `07:00`. Absolute rather than a countdown: a countdown means a timer repainting forever. */
export function formatClock(atMs: number): string {
  return clockFormatter.format(new Date(atMs));
}

/** `45m`, `8h`, `8h 30m`, `2d 3h`. Rounded down, because a bound that reads long is a lie. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

/** `just now`, `12m ago`, `3h 05m ago`. Never a negative age, even against a skewed clock. */
export function formatAge(atMs: number, nowMs: number): string {
  const elapsed = nowMs - atMs;
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  return `${formatDuration(elapsed)} ago`;
}

const STOP_COPY: Readonly<Record<LoopStopReason, LoopStateCopy>> = {
  done: {
    label: "Done",
    tone: "done",
    detail: "The agent said it had finished, so the loop stopped on its own signal.",
  },
  // Zinc, never emerald. The agent never signalled done — the run hit a bound.
  spent: {
    label: "Out of rope",
    tone: "spent",
    detail: "The budget or the deadline ran out. It did not finish — it was stopped.",
  },
  stalled: {
    label: "Stalled",
    tone: "spent",
    detail: "Two check-ins in a row moved nothing, so the loop stopped spending on it.",
  },
  "handed-back": {
    label: "Handed back",
    tone: "muted",
    detail: "You took over, so supervision stopped. The budget was not reset.",
  },
};

export function describeStop(reason: LoopStopReason): LoopStateCopy {
  return STOP_COPY[reason];
}

const STAND_DOWN_DETAIL: Readonly<Record<string, string>> = {
  disabled: "Loops are switched off in Settings. Nothing fires, and nothing was disarmed.",
  snoozed: "The thread is snoozed. Unsnooze it and the loop picks up where it left off.",
  pending_input: "Something is waiting on you in the composer. Answer it and the loop resumes.",
  rate_limited: "A usage limit is in force. Auto-resume owns the wake; no check-in was spent.",
};

/**
 * The state the console leads with.
 *
 * Reads the server's `derived` view rather than re-deriving anything: the route already resolved
 * the terminal-first ordering, and a second opinion computed in the browser would drift.
 */
export function describeLoopState(derived: LoopDerived): LoopStateCopy {
  switch (derived.state) {
    case "stopped":
      return describeStop(derived.stoppedReason ?? "spent");
    case "off":
      return {
        label: "Not armed",
        tone: "muted",
        detail: "Nothing is supervising this thread.",
      };
    case "standing_down":
      return {
        label: "Standing down",
        tone: "muted",
        detail:
          STAND_DOWN_DETAIL[derived.reason ?? ""] ??
          "A guard is holding the loop back. Its budget and deadline are intact.",
      };
    case "held":
      return {
        label: "Held",
        tone: "held",
        detail:
          derived.rateLimitedUntilMs > 0
            ? `Usage limit until ${formatClock(derived.rateLimitedUntilMs)}. No check-in was spent.`
            : STAND_DOWN_DETAIL.rate_limited!,
      };
    case "blocked":
      return {
        label: "Waiting on you",
        tone: "attention",
        detail:
          STAND_DOWN_DETAIL[derived.reason ?? ""] ??
          "The loop cannot go further without a decision from you.",
      };
    case "self_pacing":
      return {
        label: "Self-pacing",
        tone: "active",
        detail:
          derived.nextWakeAtMs === null
            ? "The agent is scheduling its own wake-ups. T3 is standing by."
            : `The agent scheduled its own wake for ${formatClock(derived.nextWakeAtMs)}. T3 stands by and spends nothing.`,
      };
    case "watching":
      return {
        label: "Watching",
        tone: "active",
        detail: "Running. The loop checks in only if the thread goes quiet.",
      };
  }
}

/** `2 of 6 check-ins · ends 07:00`, the one line the collapsed pill has room for. */
export function summariseBounds(derived: LoopDerived): string {
  const budget = `${derived.checkInsUsed} of ${derived.maxCheckIns} check-ins`;
  if (derived.deadlineAtMs <= 0) return budget;
  return `${budget} · ends ${formatClock(derived.deadlineAtMs)}`;
}

export interface BlockerPartition {
  /** Unanswered — what is actionable now. */
  readonly open: ReadonlyArray<LoopBlocker>;
  /** Answered, but the agent has not been told yet. It banks on the next check-in. */
  readonly banked: ReadonlyArray<LoopBlocker>;
  /** Answered and restated to the agent. */
  readonly delivered: ReadonlyArray<LoopBlocker>;
}

/**
 * Splits blockers three ways, because "answered" and "the agent knows" are different facts.
 *
 * Answering at 09:04 while the thread is idle does nothing until the next check-in prompt carries
 * the answer, and a console that showed only "answered" would imply the agent had already acted
 * on it.
 */
export function partitionBlockers(blockers: ReadonlyArray<LoopBlocker>): BlockerPartition {
  const open: Array<LoopBlocker> = [];
  const banked: Array<LoopBlocker> = [];
  const delivered: Array<LoopBlocker> = [];
  for (const blocker of blockers) {
    if (blocker.answeredAtMs === null) open.push(blocker);
    else if (blocker.deliveredToAgent) delivered.push(blocker);
    else banked.push(blocker);
  }
  return { open, banked, delivered };
}

export interface UserInputPartition {
  readonly open: ReadonlyArray<LoopUserInput>;
  readonly answered: ReadonlyArray<LoopUserInput>;
  /**
   * Settled by session teardown as an empty answer — nobody ever saw it.
   *
   * Upstream leaves no trace of these: `hasPendingUserInput` reads false afterwards, so a voided
   * question is otherwise indistinguishable from an answered one.
   */
  readonly voided: ReadonlyArray<LoopUserInput>;
}

export function partitionUserInputs(userInputs: ReadonlyArray<LoopUserInput>): UserInputPartition {
  const open: Array<LoopUserInput> = [];
  const answered: Array<LoopUserInput> = [];
  const voided: Array<LoopUserInput> = [];
  for (const entry of userInputs) {
    if (entry.resolution === null) open.push(entry);
    else if (entry.resolution === "voided") voided.push(entry);
    else answered.push(entry);
  }
  return { open, answered, voided };
}

export interface DeferredChannelNotice {
  readonly title: string;
  readonly detail: string;
}

/**
 * The named degraded state for the deferred-question channel.
 *
 * `raise_blocker` reaches the agent over the per-thread MCP credential, which
 * `prepareMcpSession` mints only while **Settings → Integrations → Agent browser access** is on.
 * With it off the agent has no way to raise a question at all, so an empty list here is not
 * evidence of "no questions" — it is evidence of no channel. Returns `null` only when the channel
 * is genuinely available, or when the client cannot see the setting at all (there is no primary
 * environment to read it from, so claiming either way would be a guess).
 */
export function resolveDeferredChannelNotice(input: {
  readonly browserAccessKnown: boolean;
  readonly browserAccessEnabled: boolean;
}): DeferredChannelNotice | null {
  if (!input.browserAccessKnown || input.browserAccessEnabled) return null;
  return {
    title: "Deferred questions unavailable",
    detail:
      "Agent browser access is off in Settings → Integrations, so the agent cannot raise a question without stopping. An empty list here does not mean it had nothing to ask.",
  };
}

const REFUSAL_COPY: Readonly<Record<string, string>> = {
  deadline_required: "Pick an end time. A loop with no deadline is not a bound.",
  deadline_in_past: "That end time has already passed.",
  budget_required: "Set how many check-ins this run may spend.",
  budget_too_large: "The most a single run may spend is 20 check-ins.",
  budget_too_small: "A run needs at least one check-in.",
  ceiling_reached: "Too many loops are already armed. Disarm one, or raise the limit in Settings.",
  thread_snoozed: "This thread is snoozed. Unsnooze it first — arming would cancel the snooze.",
  unknown_thread: "That thread is not in this environment any more.",
  projection_unavailable: "The thread index is unavailable right now. Try again in a moment.",
  invalid_body: "The server did not understand that request.",
  out_of_range: "One of those values is outside the range the server accepts.",
  not_found: "That question is no longer open.",
};

/**
 * A refusal, worded for a human, with the server's own code alongside it.
 *
 * The code is carried verbatim rather than swallowed: the route gives every 400 a distinct code so
 * the console can word them differently, and showing it keeps a refusal the console has no copy
 * for from rendering as a blank failure.
 */
export function describeRefusal(code: string): { readonly code: string; readonly message: string } {
  return {
    code,
    message: REFUSAL_COPY[code] ?? "The server refused that change.",
  };
}

/** One ledger row, from derived facts only — never a model-authored summary of its own night. */
export function describeCheckInRow(row: LoopCheckInRow): string {
  const outcome =
    row.outcome === "productive"
      ? "the thread moved"
      : row.outcome === "unproductive"
        ? "nothing moved"
        : "outcome not yet judged";
  return `Checked in at ${formatClock(row.firedAtMs)} — ${outcome}`;
}

export interface LoopEmptyState {
  readonly headline: string;
  readonly lines: ReadonlyArray<string>;
}

/**
 * What the console says when there is nothing to answer.
 *
 * This is the acceptance case: a run that ended `spent` with a model that never called
 * `raise_blocker` still has to say something useful — what happened, what it consumed, and when it
 * last moved — rather than rendering an empty list.
 */
export function describeEmptyState(view: LoopView, nowMs: number): LoopEmptyState {
  const { derived, record } = view;
  const lines: Array<string> = [];
  if (derived.state === "stopped") {
    const stop = describeStop(derived.stoppedReason ?? "spent");
    lines.push(stop.detail);
    if (record.stopped !== null && record.stopped.detail !== "") {
      lines.push(record.stopped.detail);
    }
    lines.push(
      `Used ${derived.checkInsUsed} of ${derived.maxCheckIns} check-ins${
        derived.deadlineAtMs > 0 ? ` against a ${formatClock(derived.deadlineAtMs)} deadline` : ""
      }.`,
    );
    const lastRow = record.checkIns.at(-1);
    lines.push(
      lastRow === undefined
        ? "It never checked in — the run ended before the thread went quiet."
        : `Last activity ${formatAge(lastRow.firedAtMs, nowMs)}.`,
    );
    return {
      headline:
        derived.stoppedReason === "done"
          ? "Finished. Nothing is waiting on you."
          : "Stopped. Nothing is waiting on you.",
      lines,
    };
  }

  if (derived.state === "off") {
    return {
      headline: "No loop on this thread.",
      lines: ["Arm one to keep it working while you are away."],
    };
  }

  const state = describeLoopState(derived);
  lines.push(state.detail);
  lines.push(summariseBounds(derived));
  return { headline: "Nothing is waiting on you.", lines };
}

export interface ArmDraft {
  readonly goal: string;
  readonly maxCheckIns: number;
  readonly deadlineAtMs: number;
}

/**
 * Seeds the arm form.
 *
 * `defaultRunMs` seeds the *form*, and only the form. It is never a fallback deadline on the
 * server: a deadline the human did not choose is not a bound they agreed to, which is why the
 * route 400s rather than defaulting one.
 */
export function seedArmDraft(input: {
  readonly settings: LoopSettings | null;
  readonly record: LoopView["record"];
  readonly nowMs: number;
}): ArmDraft {
  const settings = input.settings;
  const runMs = settings?.defaultRunMs ?? 8 * 3_600_000;
  return {
    goal: input.record.goal ?? "",
    maxCheckIns:
      input.record.maxCheckIns > 0 ? input.record.maxCheckIns : (settings?.defaultMaxCheckIns ?? 6),
    deadlineAtMs:
      input.record.deadlineAtMs > input.nowMs ? input.record.deadlineAtMs : input.nowMs + runMs,
  };
}

/**
 * `2026-09-02T23:00` for `<input type="datetime-local">`, in the reader's own timezone.
 *
 * The server stores an absolute instant; the browser is the only party that knows what "23:00
 * tonight" means to the person typing it.
 */
export function toDateTimeLocalValue(atMs: number): string {
  const at = new Date(atMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The inverse, or `null` when the field is empty or half-typed.
 *
 * The shape is checked before `Date` sees it: `new Date("2026-09-")` parses happily as the first
 * of September, so leaning on `Number.isFinite` alone would turn a half-typed field into a real
 * deadline the human never chose.
 */
const DATE_TIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function fromDateTimeLocalValue(value: string): number | null {
  if (!DATE_TIME_LOCAL.test(value)) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** How many things are actually waiting on a human, for the pill's count. */
export function countWaiting(view: LoopView): number {
  const blockers = partitionBlockers(view.record.blockers).open.length;
  const nativeOpen = partitionUserInputs(view.record.userInputs).open.length;
  return blockers + nativeOpen;
}
