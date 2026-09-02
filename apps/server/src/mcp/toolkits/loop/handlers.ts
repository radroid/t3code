/**
 * Handlers for the loop toolkit, plus the layer that registers it on the MCP server.
 *
 * Everything here obeys four rules that the tests pin:
 *
 *  1. **Attribution is read, never accepted.** `threadId` comes from
 *     `McpInvocationContext`, which the per-thread bearer credential resolves. There is no
 *     argument to spoof, and an extra `threadId` in the payload is stripped by the
 *     parameter schema before a handler ever sees it.
 *  2. **`raise_blocker` awaits nothing but its own write.** It appends to the record and
 *     returns. It never constructs, reads or waits on a `Deferred`, which is the entire
 *     reason the tool exists.
 *  3. **The cap reports itself.** A capped call comes back as `status: "capped"` with the
 *     numbers, so the agent knows the question was not banked. Silently dropping it would
 *     reproduce the failure `raise_blocker` was built to prevent.
 *  4. **Nothing fails.** The gate (`global.enabled`), an unarmed thread and a thread that
 *     has never been supervised are all statuses. A tool that errors mid-turn costs the
 *     agent reasoning it should be spending on the work.
 *
 * @module mcp/toolkits/loop/handlers
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import { McpServer } from "effect/unstable/ai";

import { LoopStoreLive } from "../../../coil/loop/layer.ts";
import { type Blocker, type BlockerOption, LoopStore } from "../../../coil/loop/state.ts";
import { deriveLoopStatus } from "../../../coil/loop/status.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LoopToolkit } from "./tools.ts";

/**
 * How many *unanswered* blockers one check-in window may hold.
 *
 * The brief calls this a per-turn cap. `McpInvocationContext` carries no turn identity —
 * `{environmentId, threadId, providerSessionId, providerInstanceId, capabilities, issuedAt}`
 * and nothing else — so the window is the check-in, which is the loop's unit of work
 * anyway, and for a thread with no loop it degrades to "at most this many questions
 * outstanding at once". Only unanswered blockers count, so a human answering always frees
 * budget, and no agent can permanently exhaust its own channel.
 *
 * Deliberately a constant here rather than in `coil/loop/config.ts`: it bounds a tool, not
 * the supervisor, and there is no operator story for tuning it yet. Promote it to
 * `COIL_LOOP_MAX_BLOCKERS_PER_TURN` the first time someone actually hits it.
 */
export const MAX_OPEN_BLOCKERS_PER_WINDOW = 10;

/** Bounds one blocker's contribution to the state file. Truncation is always reported. */
const MAX_QUESTION_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 2_000;
const MAX_OPTIONS = 10;

const truncate = (value: string, max: number): { text: string; truncated: boolean } =>
  value.length <= max
    ? { text: value, truncated: false }
    : { text: value.slice(0, max), truncated: true };

/**
 * Trims to `UserInputQuestionOption`'s shape and drops the unusable.
 *
 * An option with no label cannot be rendered or chosen, so it is dropped rather than
 * carried as a blank row. An empty description is kept — the native component tolerates it,
 * and inventing text would put words in the agent's mouth.
 */
export const normalizeBlockerOptions = (
  options: ReadonlyArray<{ readonly label: string; readonly description: string }> | undefined,
): ReadonlyArray<BlockerOption> =>
  (options ?? [])
    .map((option) => ({ label: option.label.trim(), description: option.description.trim() }))
    .filter((option) => option.label.length > 0)
    .slice(0, MAX_OPTIONS);

/**
 * The start of the current cap window.
 *
 * The last check-in when there is one, otherwise the arm, otherwise the beginning of time —
 * which is the right reading for a thread with no loop, where every open blocker counts.
 */
export const capWindowStartMs = (input: {
  readonly armedAtMs: number;
  readonly lastCheckInAtMs: number | null;
}): number => Math.max(input.armedAtMs, input.lastCheckInAtMs ?? 0);

const handlers = {
  raise_blocker: Effect.fn("LoopToolkit.raise_blocker")(function* (input) {
    const { threadId } = yield* McpInvocationContext.McpInvocationContext;
    const store = yield* LoopStore;
    const global = yield* store.getGlobal;
    const record = yield* store.getThread(threadId);
    const open = record.blockers.filter((entry) => entry.answeredAtMs === null);

    if (!global.enabled) {
      return {
        status: "unavailable" as const,
        id: null,
        detail:
          "Loops are switched off for this machine, so nothing would ever read this question. Ask directly instead.",
        openBlockers: open.length,
        cap: MAX_OPEN_BLOCKERS_PER_WINDOW,
      };
    }

    const windowStartMs = capWindowStartMs({
      armedAtMs: record.armedAtMs,
      lastCheckInAtMs: record.lastCheckIn?.firedAtMs ?? null,
    });
    const openThisWindow = open.filter((entry) => entry.raisedAtMs >= windowStartMs);
    if (openThisWindow.length >= MAX_OPEN_BLOCKERS_PER_WINDOW) {
      return {
        status: "capped" as const,
        id: null,
        detail: `Not recorded: ${openThisWindow.length} questions are already waiting on a human (cap ${MAX_OPEN_BLOCKERS_PER_WINDOW}). Carry on with work that does not depend on this one; the cap frees up as questions are answered.`,
        openBlockers: open.length,
        cap: MAX_OPEN_BLOCKERS_PER_WINDOW,
      };
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const suffix = yield* Random.nextIntBetween(0, 0xff_ff_ff);
    const question = truncate(input.question.trim(), MAX_QUESTION_CHARS);
    const context = truncate((input.context ?? "").trim(), MAX_CONTEXT_CHARS);
    const options = normalizeBlockerOptions(input.options);
    const blocker: Blocker = {
      id: `blocker-${nowMs.toString(36)}-${suffix.toString(36).padStart(5, "0")}`,
      raisedAtMs: nowMs,
      question: question.text,
      options,
      context: context.text.length > 0 ? context.text : null,
      answeredAtMs: null,
      answer: null,
      deliveredToAgent: false,
    };
    const recorded = yield* store.addBlocker(threadId, blocker);
    const droppedOptions = (input.options?.length ?? 0) - options.length;
    const notes = [
      question.truncated ? `question truncated to ${MAX_QUESTION_CHARS} characters` : null,
      context.truncated ? `context truncated to ${MAX_CONTEXT_CHARS} characters` : null,
      droppedOptions > 0 ? `${droppedOptions} unusable option(s) dropped` : null,
    ].filter((note): note is string => note !== null);
    return {
      status: "recorded" as const,
      id: recorded.id,
      detail:
        notes.length === 0
          ? "Recorded. Keep working; the answer arrives in a later check-in message."
          : `Recorded (${notes.join("; ")}). Keep working; the answer arrives in a later check-in message.`,
      openBlockers: open.length + 1,
      cap: MAX_OPEN_BLOCKERS_PER_WINDOW,
    };
  }),

  loop_status: Effect.fn("LoopToolkit.loop_status")(function* () {
    const { threadId } = yield* McpInvocationContext.McpInvocationContext;
    const store = yield* LoopStore;
    const global = yield* store.getGlobal;
    const record = yield* store.getThread(threadId);
    const nowMs = yield* Clock.currentTimeMillis;
    // No thread shell here: an MCP call has a store and nothing else. The shell-derived
    // clauses (snooze, blocked-on-a-human) are skipped rather than guessed — and an agent
    // running well enough to call this is not the thread those clauses describe.
    const status = deriveLoopStatus({ nowMs, record, global, shell: null });
    return {
      armed: status.armed,
      reason: status.reason,
      state: status.state,
      checkInsUsed: status.checkInsUsed,
      maxCheckIns: status.maxCheckIns,
      deadlineAtMs: status.deadlineAtMs,
      msToDeadline: status.msToDeadline,
      blockersOpen: record.blockers.filter((entry) => entry.answeredAtMs === null).length,
    };
  }),

  loop_done: Effect.fn("LoopToolkit.loop_done")(function* (input) {
    const { threadId } = yield* McpInvocationContext.McpInvocationContext;
    const store = yield* LoopStore;
    const global = yield* store.getGlobal;
    const record = yield* store.getThread(threadId);

    if (!global.enabled) {
      return {
        ok: true,
        status: "disabled" as const,
        detail: "Loops are switched off for this machine; there is no run to end.",
      };
    }
    if (!record.armed || record.stopped !== null) {
      return {
        ok: true,
        status: "no-loop" as const,
        detail: "No loop is running on this thread, so there was nothing to end.",
      };
    }

    // Exactly what `guards.ts` `doneSignal` reads: a timestamp newer than `armedAtMs`. The
    // record is never cleared, for the same reason the supervisor never deletes a
    // `.coil/loop-done` file — a re-arm takes a fresh `armedAtMs` and supersedes both.
    const nowMs = yield* Clock.currentTimeMillis;
    const reason = truncate(input.reason.trim(), MAX_CONTEXT_CHARS).text;
    yield* store.update(threadId, (current) => ({
      ...current,
      loopDoneAtMs: nowMs,
      loopDoneReason: reason.length > 0 ? reason : null,
    }));
    return {
      ok: true,
      status: "recorded" as const,
      detail: "Run marked done. No further check-ins will be sent for it.",
    };
  }),
} satisfies Parameters<typeof LoopToolkit.toLayer>[0];

export const LoopToolkitHandlersLive = LoopToolkit.toLayer(handlers);

/**
 * Registers the three tools on the shared `McpServer`.
 *
 * `LoopStore` is provided here rather than left open, so the fork never widens the type of
 * upstream's `makeRoutesLayer`: an unsatisfied requirement in `McpHttpServer.layer` would
 * surface in `server.ts` and cost a second seam edit. `LoopStoreLive` is the same
 * module-level layer value the reactor and the HTTP routes use, so all three share one
 * store over one file.
 */
export const LoopToolkitRegistrationLive = McpServer.toolkit(LoopToolkit).pipe(
  Layer.provide(LoopToolkitHandlersLive),
  Layer.provide(LoopStoreLive),
);
