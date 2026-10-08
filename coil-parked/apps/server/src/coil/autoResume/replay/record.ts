/**
 * The recorder: provider log → committed replay fixture.
 *
 * This is the piece that fixes the economics of testing auto-resume. A real usage-limit
 * rejection is rare and unschedulable — you get one when you happen to exhaust a window,
 * which historically meant a defect could sit for weeks between reproductions. Every
 * episode captured here is replayable forever after, so the supply of test cases grows
 * with ordinary use instead of with deliberate quota exhaustion.
 *
 * Usage is two steps: `scanForLimitEpisodes` finds windows worth keeping in a log, then
 * `buildEpisode` lifts one into a redacted fixture.
 *
 * @module coil/autoResume/replay/record
 */

import {
  EPISODE_FORMAT_VERSION,
  type Episode,
  type EpisodeCanonicalEvent,
  type EpisodeNativeStep,
} from "./episode.ts";
import {
  bodyType,
  canonicalRuntimeEvent,
  nativeSdkMessage,
  parseProviderLog,
  type ProviderLogEntry,
} from "./providerLog.ts";
import { mergeReports, redact, REDACTION_POLICY, type RedactionReport } from "./redact.ts";

/** Default padding around a rate-limit event, wide enough to include the turn that died. */
export const DEFAULT_LEAD_MS = 5 * 60_000;
export const DEFAULT_TRAIL_MS = 10 * 60_000;

/**
 * What a rate-limit event actually means for the session, which `status` alone does not
 * say. Measured against 218 real events in local logs, the distinction matters a lot:
 * `overageStatus:"rejected"` is overwhelmingly *not* a block — it is the steady state of
 * an org with overage disabled, emitted while the window is happily `allowed`. Reading it
 * as "blocked" would make auto-resume fire constantly against a session that never stopped.
 *
 *   | class                  | window     | overage    | session |
 *   |------------------------|------------|------------|---------|
 *   | `hard-block`           | rejected   | rejected   | stopped, with no fallback |
 *   | `overage-covering`     | rejected   | allowed    | still running on overage  |
 *   | `window-rejected`      | rejected   | unknown    | stopped                   |
 *   | `overage-unavailable`  | allowed    | rejected   | fine — not a block         |
 *   | `allowed`              | allowed    | allowed    | fine                       |
 *
 * `hard-block` is #118's terminal event, and the one class a `resetsAt`-based resume can
 * get wrong: when the blocker is a spend cap rather than the window, the window reopening
 * changes nothing.
 */
export type RateLimitBlockClass =
  | "hard-block"
  | "overage-covering"
  | "window-rejected"
  | "overage-unavailable"
  | "allowed";

export interface RateLimitSighting {
  readonly sourceLine: number;
  readonly observedAt: string;
  readonly status: string | null;
  readonly overageStatus: string | null;
  readonly overageDisabledReason: string | null;
  readonly rateLimitType: string | null;
  readonly blockClass: RateLimitBlockClass;
  /**
   * Whether this event arms a resume today: the classifier's sole criterion is
   * `rate_limit_info.status === "rejected"` (classifyRateLimit.ts:64-75).
   */
  readonly armsAutoResume: boolean;
}

function classifyBlock(status: string | null, overageStatus: string | null): RateLimitBlockClass {
  if (status === "rejected") {
    if (overageStatus === "rejected") return "hard-block";
    if (overageStatus === "allowed" || overageStatus === "allowed_warning") {
      return "overage-covering";
    }
    return "window-rejected";
  }
  return overageStatus === "rejected" ? "overage-unavailable" : "allowed";
}

function rateLimitInfo(message: unknown): Record<string, unknown> | null {
  if (typeof message !== "object" || message === null) return null;
  const info = (message as { rate_limit_info?: unknown }).rate_limit_info;
  return typeof info === "object" && info !== null ? (info as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Find every rate-limit event in a log, classified the way the reactor would classify it.
 *
 * Point this at a directory of logs to answer "which of my sessions actually hit a limit,
 * and would auto-resume have noticed?" — the question #118 could not answer from outside.
 */
export function scanForLimitEpisodes(contents: string): ReadonlyArray<RateLimitSighting> {
  const { entries } = parseProviderLog(contents);
  const sightings: RateLimitSighting[] = [];

  for (const entry of entries) {
    if (entry.stream !== "native") continue;
    const message = nativeSdkMessage(entry);
    if (bodyType(message) !== "rate_limit_event") continue;

    const info = rateLimitInfo(message);
    const status = stringField(info, "status");
    const overageStatus = stringField(info, "overageStatus");

    sightings.push({
      sourceLine: entry.lineNumber,
      observedAt: entry.observedAt,
      status,
      overageStatus,
      overageDisabledReason: stringField(info, "overageDisabledReason"),
      rateLimitType: stringField(info, "rateLimitType"),
      blockClass: classifyBlock(status, overageStatus),
      armsAutoResume: status === "rejected",
    });
  }

  return sightings;
}

export interface EpisodeWindow {
  /** Inclusive 1-based source line bounds. */
  readonly fromLine: number;
  readonly toLine: number;
}

/**
 * A window centred on the rate-limit events in a log: from `leadMs` before the first to
 * `trailMs` after the last, so the fixture contains the turn that hit the limit and
 * whatever the session did next (which for #118 is the whole point — the graceful exit
 * and the wake tick that burned a turn both land in the trail).
 */
export function limitEpisodeWindow(
  contents: string,
  options?: {
    readonly leadMs?: number;
    readonly trailMs?: number;
    /**
     * Centre only on events that stop the session (`status:"rejected"`). Default true:
     * an ordinary session emits `allowed` rate-limit telemetry throughout, so centring on
     * every rate-limit event stretches the window across the whole log and produces a
     * fixture that is mostly unrelated traffic.
     */
    readonly stoppingOnly?: boolean;
  },
): EpisodeWindow | null {
  const { entries } = parseProviderLog(contents);
  const stoppingOnly = options?.stoppingOnly ?? true;
  const sightings = scanForLimitEpisodes(contents);
  const anchorLines = new Set(
    sightings
      .filter((sighting) => (stoppingOnly ? sighting.armsAutoResume : true))
      .map((sighting) => sighting.sourceLine),
  );

  const limitTimes = entries
    .filter((entry) => anchorLines.has(entry.lineNumber))
    .map((entry) => Date.parse(entry.observedAt))
    .filter((time) => Number.isFinite(time));

  if (limitTimes.length === 0) return null;

  const leadMs = options?.leadMs ?? DEFAULT_LEAD_MS;
  const trailMs = options?.trailMs ?? DEFAULT_TRAIL_MS;
  const from = Math.min(...limitTimes) - leadMs;
  const to = Math.max(...limitTimes) + trailMs;

  const inWindow = entries.filter((entry) => {
    const time = Date.parse(entry.observedAt);
    return Number.isFinite(time) && time >= from && time <= to;
  });
  if (inWindow.length === 0) return null;

  return {
    fromLine: inWindow[0]!.lineNumber,
    toLine: inWindow[inWindow.length - 1]!.lineNumber,
  };
}

function threadIdOf(entries: ReadonlyArray<ProviderLogEntry>): string | null {
  for (const entry of entries) {
    const event = canonicalRuntimeEvent(entry);
    if (event === null) continue;
    const threadId = (event as { threadId?: unknown }).threadId;
    if (typeof threadId === "string") return threadId;
  }
  return null;
}

export interface BuildEpisodeInput {
  readonly contents: string;
  /** Basename only; a full path would carry a username into the fixture. */
  readonly sourceFile: string;
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly origin?: Episode["origin"];
  readonly window?: EpisodeWindow;
}

/**
 * Lift a window of a provider log into a redacted, committable episode.
 *
 * Offsets are relative to the first entry in the window, so a replay can drive a TestClock
 * through hours of real elapsed time in milliseconds.
 */
export function buildEpisode(input: BuildEpisodeInput): Episode {
  const { entries, malformed } = parseProviderLog(input.contents);
  const window = input.window;
  const selected =
    window === undefined
      ? entries
      : entries.filter(
          (entry) => entry.lineNumber >= window.fromLine && entry.lineNumber <= window.toLine,
        );

  if (selected.length === 0) {
    throw new Error(`buildEpisode: no log entries in window for '${input.id}'`);
  }

  const baseMs = Date.parse(selected[0]!.observedAt);
  const offsetOf = (observedAt: string): number => {
    const time = Date.parse(observedAt);
    return Number.isFinite(time) && Number.isFinite(baseMs) ? time - baseMs : 0;
  };

  const reports: RedactionReport[] = [];
  const native: EpisodeNativeStep[] = [];
  const canonical: EpisodeCanonicalEvent[] = [];

  for (const entry of selected) {
    if (entry.stream === "native") {
      const message = nativeSdkMessage(entry);
      if (message === null) continue;
      const { value, report } = redact(message);
      reports.push(report);
      native.push({
        offsetMs: offsetOf(entry.observedAt),
        observedAt: entry.observedAt,
        sourceLine: entry.lineNumber,
        message: value,
      });
      continue;
    }

    if (entry.stream === "canonical") {
      const event = canonicalRuntimeEvent(entry);
      const type = bodyType(event);
      if (event === null || type === null) continue;
      const { value, report } = redact(event);
      reports.push(report);
      canonical.push({
        offsetMs: offsetOf(entry.observedAt),
        observedAt: entry.observedAt,
        sourceLine: entry.lineNumber,
        type,
        event: value,
      });
    }
  }

  const last = selected[selected.length - 1]!;
  const merged = mergeReports(reports);

  return {
    formatVersion: EPISODE_FORMAT_VERSION,
    id: input.id,
    title: input.title,
    origin: input.origin ?? "capture",
    notes: input.notes,
    threadId: threadIdOf(selected),
    provenance: {
      sourceFile: input.sourceFile,
      firstObservedAt: selected[0]!.observedAt,
      lastObservedAt: last.observedAt,
      firstSourceLine: selected[0]!.lineNumber,
      lastSourceLine: last.lineNumber,
      malformedLines: malformed.length,
    },
    redaction: {
      policy: REDACTION_POLICY,
      redactedStrings: merged.redactedStrings,
      keptVendorStrings: merged.keptVendorStrings,
    },
    native,
    canonical,
  };
}

/** Serialize an episode for committing: stable key order, trailing newline. */
export function serializeEpisode(episode: Episode): string {
  return `${JSON.stringify(episode, null, 2)}\n`;
}
