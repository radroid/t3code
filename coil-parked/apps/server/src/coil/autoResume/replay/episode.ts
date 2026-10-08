/**
 * The replay fixture format.
 *
 * An *episode* is a redacted slice of one thread's provider log covering a usage-limit
 * event: the native SDK messages the adapter consumed, and the canonical runtime events it
 * produced at capture time. Replaying the first through the real adapter and diffing
 * against the second turns a one-off incident into a permanent regression test.
 *
 * Why both halves are stored: auto-resume has now failed three times (#6, #39, #118) with
 * the same symptom — "it silently didn't fire" — and no way to tell *which* layer dropped
 * the signal. With both halves captured, a replay localises the failure by itself: if the
 * adapter reproduces the recorded canonical events, the adapter is exonerated and the
 * defect is in the reactor; if it does not, the defect is in the adapter or the SDK.
 *
 * Fixtures are committed, so everything here has been through `redact.ts` first.
 *
 * @module coil/autoResume/replay/episode
 */

export const EPISODE_FORMAT_VERSION = 1;

/** A native SDK message to feed back into a `FakeClaudeQuery`. */
export interface EpisodeNativeStep {
  /** Milliseconds after the episode's first entry — drives the TestClock during replay. */
  readonly offsetMs: number;
  readonly observedAt: string;
  /** 1-based line in the source log, so a failure can be traced back to the capture. */
  readonly sourceLine: number;
  readonly message: unknown;
}

/** A canonical runtime event the adapter produced at capture time. */
export interface EpisodeCanonicalEvent {
  readonly offsetMs: number;
  readonly observedAt: string;
  readonly sourceLine: number;
  readonly type: string;
  readonly event: unknown;
}

export interface EpisodeRedaction {
  readonly policy: string;
  readonly redactedStrings: number;
  readonly keptVendorStrings: number;
}

export interface EpisodeProvenance {
  /** Log file basename only — never a full path, which would carry a username. */
  readonly sourceFile: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly firstSourceLine: number;
  readonly lastSourceLine: number;
  /** Lines the parser could not read, if any — an honest record of capture fidelity. */
  readonly malformedLines: number;
}

export interface Episode {
  readonly formatVersion: typeof EPISODE_FORMAT_VERSION;
  readonly id: string;
  readonly title: string;
  /**
   * `capture` — lifted from a real provider log, faithful to what the provider sent.
   * `reconstruction` — hand-built from an incident report. Kept explicit so nobody
   * mistakes an inferred payload for observed ground truth.
   */
  readonly origin: "capture" | "reconstruction";
  readonly notes: string;
  readonly threadId: string | null;
  readonly provenance: EpisodeProvenance;
  readonly redaction: EpisodeRedaction;
  readonly native: ReadonlyArray<EpisodeNativeStep>;
  readonly canonical: ReadonlyArray<EpisodeCanonicalEvent>;
}

/** Total wall-clock the episode spans, in ms. */
export function episodeDurationMs(episode: Episode): number {
  const last = episode.native[episode.native.length - 1];
  return last?.offsetMs ?? 0;
}

/** Native steps whose message is of the given SDK type. */
export function nativeStepsOfType(
  episode: Episode,
  type: string,
): ReadonlyArray<EpisodeNativeStep> {
  return episode.native.filter(
    (step) =>
      typeof step.message === "object" &&
      step.message !== null &&
      (step.message as { type?: unknown }).type === type,
  );
}

/** Canonical events of the given runtime-event type. */
export function canonicalEventsOfType(
  episode: Episode,
  type: string,
): ReadonlyArray<EpisodeCanonicalEvent> {
  return episode.canonical.filter((entry) => entry.type === type);
}
