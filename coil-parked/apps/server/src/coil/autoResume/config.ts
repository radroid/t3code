/**
 * Auto-resume configuration and resume-prompt resolution.
 *
 * Config is read from env with safe defaults, so the feature works with zero setup.
 * `resolveConfig` is pure (env passed in) for testability.
 *
 * @module coil/autoResume/config
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface AutoResumeConfig {
  readonly enabled: boolean;
  readonly pollMs: number;
  readonly maxResumesPer24h: number;
  readonly safetyMarginMs: number;
  /** Backoff ladder (ms) used when the SDK omits `resetsAt`; the last value is the cap. */
  readonly backoffLadderMs: ReadonlyArray<number>;
}

export const DEFAULT_BACKOFF_LADDER_MS: ReadonlyArray<number> = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

const DEFAULTS: AutoResumeConfig = {
  enabled: true,
  pollMs: 30_000,
  maxResumesPer24h: 10,
  safetyMarginMs: 60_000,
  backoffLadderMs: DEFAULT_BACKOFF_LADDER_MS,
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLadder(
  value: string | undefined,
  fallback: ReadonlyArray<number>,
): ReadonlyArray<number> {
  if (value === undefined) return fallback;
  const parts = value
    .split(",")
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts : fallback;
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): AutoResumeConfig {
  return {
    enabled: parseBool(env.T3X_AUTO_RESUME_ENABLED, DEFAULTS.enabled),
    pollMs: parsePositiveInt(env.T3X_AUTO_RESUME_POLL_MS, DEFAULTS.pollMs),
    maxResumesPer24h: parsePositiveInt(env.T3X_AUTO_RESUME_MAX_PER_24H, DEFAULTS.maxResumesPer24h),
    safetyMarginMs: parsePositiveInt(env.T3X_AUTO_RESUME_SAFETY_MARGIN_MS, DEFAULTS.safetyMarginMs),
    backoffLadderMs: parseLadder(env.T3X_AUTO_RESUME_BACKOFF_MS, DEFAULTS.backoffLadderMs),
  };
}

/** The backoff delay for the Nth (0-based) attempt when no `resetsAt` is known. */
export function backoffDelayMs(ladder: ReadonlyArray<number>, attemptIndex: number): number {
  if (ladder.length === 0) return DEFAULT_BACKOFF_LADDER_MS[DEFAULT_BACKOFF_LADDER_MS.length - 1]!;
  const clamped = Math.min(Math.max(attemptIndex, 0), ladder.length - 1);
  return ladder[clamped]!;
}

export const DEFAULT_RESUME_PROMPT = "continue";
export const RESUME_PROMPT_RELATIVE_PATH = ".t3x/resume-prompt.md";

/**
 * Resolve the text to send on resume. First match wins:
 *   1. an explicit per-thread override (passed in from durable state),
 *   2. `<workspaceRoot>/.t3x/resume-prompt.md` committed in the thread's repo,
 *   3. the literal "continue".
 * Never fails: any file error falls through to the default.
 */
export function resolveResumePrompt(input: {
  readonly workspaceRoot: string | null;
  readonly threadOverride?: string | null;
}): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const override = input.threadOverride?.trim();
    if (override) return override;

    if (input.workspaceRoot) {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const promptPath = path.join(input.workspaceRoot, RESUME_PROMPT_RELATIVE_PATH);
      const fromFile = yield* fs.readFileString(promptPath).pipe(
        Effect.map((text) => text.trim()),
        Effect.orElseSucceed(() => ""),
      );
      if (fromFile) return fromFile;
    }

    return DEFAULT_RESUME_PROMPT;
  });
}
