// @effect-diagnostics globalDate:off - formats an explicit deadline timestamp; this reads no ambient clock.
/**
 * Loop configuration and check-in prompt composition.
 *
 * Config is read from env with safe defaults so the feature works with zero setup, and
 * `resolveConfig` is pure (env passed in) for testability. The env prefix is `COIL_LOOP_*`:
 * the neighbouring fork features use `T3X_*`, which are legacy names kept only to avoid
 * orphaning state on machines that already set them.
 *
 * `COIL_LOOP_ENABLED` is the deployment kill switch and the ONLY condition under which the
 * supervisor fiber does not exist. It is not the user-facing toggle — that is
 * `global.enabled` in the durable store, which is a guard rather than a lifecycle: flipping
 * it off stands every loop down without disarming or stopping anything.
 *
 * @module coil/loop/config
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface LoopConfig {
  /** `COIL_LOOP_ENABLED`. False ⇒ no fiber is forked at all. */
  readonly enabled: boolean;
  readonly pollMs: number;
  /**
   * Staleness threshold fallbacks.
   *
   * The per-thread values on the record (seeded from `global.default*` at arm time) are what
   * the trigger reads; these are the deployment-level floor a record falls back to.
   */
  readonly idleMs: number;
  readonly busyIdleMs: number;
  /** Movement below this between two check-ins counts as unproductive (a strike). */
  readonly productiveMs: number;
  /** The floor, and the whole grace for a one-shot wake. */
  readonly wakeGraceMinMs: number;
  /** The cap on a recurring wake's derived grace. */
  readonly wakeGraceMaxMs: number;
  /** Fraction of a recurring wake's period allowed as lateness before it counts as lost. */
  readonly wakeGraceFraction: number;
}

const DEFAULTS: LoopConfig = {
  enabled: true,
  pollMs: 60_000,
  idleMs: 15 * 60_000,
  busyIdleMs: 45 * 60_000,
  productiveMs: 2 * 60_000,
  wakeGraceMinMs: 90_000,
  wakeGraceMaxMs: 15 * 60_000,
  wakeGraceFraction: 0.1,
};

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFraction(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): LoopConfig {
  return {
    enabled: parseBool(env.COIL_LOOP_ENABLED, DEFAULTS.enabled),
    pollMs: parsePositiveInt(env.COIL_LOOP_POLL_MS, DEFAULTS.pollMs),
    idleMs: parsePositiveInt(env.COIL_LOOP_IDLE_MS, DEFAULTS.idleMs),
    busyIdleMs: parsePositiveInt(env.COIL_LOOP_BUSY_IDLE_MS, DEFAULTS.busyIdleMs),
    productiveMs: parsePositiveInt(env.COIL_LOOP_PRODUCTIVE_MS, DEFAULTS.productiveMs),
    wakeGraceMinMs: parsePositiveInt(env.COIL_LOOP_WAKE_GRACE_MIN_MS, DEFAULTS.wakeGraceMinMs),
    wakeGraceMaxMs: parsePositiveInt(env.COIL_LOOP_WAKE_GRACE_MAX_MS, DEFAULTS.wakeGraceMaxMs),
    wakeGraceFraction: parseFraction(env.COIL_LOOP_WAKE_GRACE_FRACTION, DEFAULTS.wakeGraceFraction),
  };
}

/**
 * How late a recorded wake may land before it counts as lost.
 *
 * Derived, not constant. The scheduler's own text is *"recurring tasks fire up to 10% of
 * their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s
 * early"*. The 90s is the **early** half and can never make a healthy wake look lost; the
 * half that matters is **late**, and it scales with the period. A flat 90s would fire
 * `wake_lost` — the strongest trigger in the design — on a merely jittered thread.
 */
export function wakeGraceMs(
  entry: { readonly recurring: boolean; readonly periodMs: number | null },
  config: Pick<LoopConfig, "wakeGraceMinMs" | "wakeGraceMaxMs" | "wakeGraceFraction">,
): number {
  const { periodMs } = entry;
  if (!entry.recurring || periodMs === null || !Number.isFinite(periodMs) || periodMs <= 0) {
    return config.wakeGraceMinMs;
  }
  return Math.max(
    config.wakeGraceMinMs,
    Math.min(periodMs * config.wakeGraceFraction, config.wakeGraceMaxMs),
  );
}

/** The agent writes this to end a run early. T3 only ever *stats* it — never writes it. */
export const LOOP_DONE_RELATIVE_PATH = ".coil/loop-done";
/** A project-committed replacement for the built-in check-in body. */
export const LOOP_PROMPT_RELATIVE_PATH = ".coil/loop-prompt.md";

/**
 * The roots to stat, **worktree first**.
 *
 * `resolveThreadWorkspaceCwd` returns the worktree first, so that is the agent's real cwd.
 * `autoResume/config.ts` resolves from `workspaceRoot` only, and copying it would put the
 * supervisor and the agent in different directories on every worktree-backed thread — the
 * done-file would be written where nothing looks for it.
 */
export function resolveLoopRoots(input: {
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}): ReadonlyArray<string> {
  const roots = [input.worktreePath, input.workspaceRoot].filter(
    (root): root is string => typeof root === "string" && root.trim().length > 0,
  );
  return [...new Set(roots)];
}

/** Verbatim, in every resolution path. See `composeCheckInPrompt`. */
export const DEFERENCE_LINE =
  "T3 checked in because no wake of yours landed. Keep scheduling your own wake-ups as normal — " +
  "T3 stands by while one is pending inside this run's deadline, covers any that are lost, and " +
  "enforces the budget and deadline.";

const BUILT_IN_BODY =
  "Continue the work already in progress on this thread. Read your most recent output first so " +
  "you resume mid-task rather than re-deriving what is already done.";

export interface BankedAnswer {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export interface CheckInPromptInput {
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
  /** The per-thread override from the durable record. */
  readonly overridePrompt: string | null;
  /** 1-based. */
  readonly checkInNumber: number;
  readonly maxCheckIns: number;
  readonly deadlineAtMs: number;
  readonly nowMs: number;
  readonly goal: string | null;
  /** Answered-but-undelivered blockers, from `store.listUndeliveredAnswers`. */
  readonly bankedAnswers: ReadonlyArray<BankedAnswer>;
}

export interface CheckInPrompt {
  readonly text: string;
  readonly source: "override" | "project-file" | "built-in";
  /** Absolute wherever a root is known — the agent cannot act on a relative instruction. */
  readonly doneFilePath: string;
  /**
   * Exactly the blockers whose answers this text carries.
   *
   * The caller flips `deliveredToAgent` for these ids AFTER the dispatch, which is what stops
   * an answer that landed mid-composition being marked delivered and silently lost.
   */
  readonly deliveredBlockerIds: ReadonlyArray<string>;
}

function formatRemaining(deadlineAtMs: number, nowMs: number): string {
  const remainingMs = Math.max(0, deadlineAtMs - nowMs);
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function formatDeadline(deadlineAtMs: number): string {
  const date = new Date(deadlineAtMs);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

/**
 * Reads the project check-in body, worktree first. Empty, whitespace-only, missing or
 * unreadable all fall through to the next root and finally to the built-in; only an
 * unreadable *existing* file logs, so an absent file is not noise.
 */
function readProjectBody(
  roots: ReadonlyArray<string>,
): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    for (const root of roots) {
      const promptPath = path.join(root, LOOP_PROMPT_RELATIVE_PATH);
      const exists = yield* fs.exists(promptPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const contents = yield* fs.readFileString(promptPath).pipe(
        Effect.map((text): string | null => text),
        Effect.orElseSucceed(() => null),
      );
      if (contents === null) {
        yield* Effect.logWarning("coil loop: check-in prompt file unreadable; using the built-in", {
          promptPath,
        });
        continue;
      }
      const trimmed = contents.trim();
      if (trimmed.length > 0) return trimmed;
    }
    return null;
  });
}

/**
 * Builds the check-in text.
 *
 * The contract is restated **in full every time**: a six-check-in overnight run compacts, and
 * a contract taught once is gone by check-in four. Resolution order for the body is
 * per-thread override → `<root>/.coil/loop-prompt.md` → built-in, but the envelope — the
 * check-in number and budget, the do-not-restart instruction, the absolute done-file path,
 * the deadline, the banked answers and the deference line — is fork-owned and identical in
 * all three, which is also what guarantees the text never begins with `/` and is therefore
 * never read as a slash command.
 */
export function composeCheckInPrompt(
  input: CheckInPromptInput,
): Effect.Effect<CheckInPrompt, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const roots = resolveLoopRoots(input);
    const doneFilePath =
      roots.length > 0 ? path.join(roots[0]!, LOOP_DONE_RELATIVE_PATH) : LOOP_DONE_RELATIVE_PATH;

    const override = input.overridePrompt?.trim();
    let body = override && override.length > 0 ? override : null;
    let source: CheckInPrompt["source"] = body === null ? "built-in" : "override";
    if (body === null) {
      const projectBody = yield* readProjectBody(roots);
      if (projectBody !== null) {
        body = projectBody;
        source = "project-file";
      } else {
        body = BUILT_IN_BODY;
      }
    }

    const sections = [
      `Loop check-in ${input.checkInNumber} of ${input.maxCheckIns}.`,
      body,
      "Do not restart from the top. Pick up exactly where you left off and keep going.",
      `This run ends at ${formatDeadline(input.deadlineAtMs)} (${formatRemaining(input.deadlineAtMs, input.nowMs)} left) or when the check-in budget runs out, whichever comes first.`,
      `When the work is genuinely finished, write the file ${doneFilePath}. Its contents do not matter; T3 reads only its timestamp. That is how you end this run early.`,
    ];

    if (input.goal !== null && input.goal.trim().length > 0) {
      sections.splice(1, 0, `The goal for this run: ${input.goal.trim()}`);
    }

    const banked = input.bankedAnswers.filter((entry) => entry.answer.trim().length > 0);
    if (banked.length > 0) {
      sections.push(
        [
          "Answers to questions you raised:",
          ...banked.map((entry) => `- ${entry.question.trim()}\n  ${entry.answer.trim()}`),
        ].join("\n"),
      );
    }

    sections.push(DEFERENCE_LINE);

    return {
      text: sections.join("\n\n"),
      source,
      doneFilePath,
      deliveredBlockerIds: banked.map((entry) => entry.id),
    };
  });
}
