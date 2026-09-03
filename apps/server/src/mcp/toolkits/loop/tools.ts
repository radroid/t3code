/**
 * The loop toolkit — a non-blocking question channel, a budget readout, and a done signal.
 *
 * `raise_blocker` is the reason this toolkit exists. `AskUserQuestion` parks the turn on a
 * `Deferred`, so an agent that hits a real fork in the road at 01:00 and asks about it
 * *correctly* stops working until someone wakes up, and the supervisor then correctly
 * refuses to nudge a thread that is blocked on a human. No tuning resolves that; a second,
 * non-blocking channel does. `raise_blocker` records the question and returns — the answer
 * is delivered on a later check-in through the prompt, never by unblocking a `Deferred`.
 *
 * Three deliberate shapes:
 *
 *  - **No `threadId` parameter, on any tool.** Attribution comes from
 *    `McpInvocationContext`, which the per-thread bearer credential resolves. A thread id in
 *    the arguments would be a value the model could get wrong or be talked into.
 *  - **`options` mirrors `UserInputQuestionOption` (`{label, description}`)** so the console
 *    renders a raised blocker with the same native component it uses for a real
 *    `AskUserQuestion`, rather than a second bespoke widget.
 *  - **Every result is a flat struct with a `status`, and no tool declares a failure.** A
 *    capped `raise_blocker`, a `loop_status` on a thread with no loop and a `loop_done` from
 *    an unsupervised thread are all *answers*, not errors. An error mid-turn is something
 *    the agent has to reason about; a status is something it can act on.
 *
 * @module mcp/toolkits/loop/tools
 */

import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { LoopStore } from "../../../coil/loop/state.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, LoopStore];

/**
 * Shaped exactly like `UserInputQuestionOption`.
 *
 * Plain strings rather than the contract's trimmed-non-empty refinements: a refusal here
 * reaches the agent as a schema error on a tool that is supposed to never fail, so the
 * handler trims and drops empties instead.
 */
const BlockerOptionInput = Schema.Struct({
  label: Schema.String.annotate({ description: "Short label for this choice." }),
  description: Schema.String.annotate({
    description: "One sentence on what choosing this option would mean.",
  }),
});

const RaiseBlockerParams = Schema.Struct({
  question: Schema.String.annotate({
    description: "The decision you need a human to make. Self-contained: it is read hours later.",
  }),
  options: Schema.optional(
    Schema.Array(BlockerOptionInput).annotate({
      description: "The choices you see. Omit for a free-text answer.",
    }),
  ),
  context: Schema.optional(
    Schema.String.annotate({
      description: "What you were doing — file, issue, branch. Shown beside the question.",
    }),
  ),
});

const RaiseBlockerResult = Schema.Struct({
  /**
   * `recorded` — banked, keep working. `capped` — too many unanswered questions already;
   * this one was NOT recorded. `unavailable` — loops are switched off machine-wide.
   */
  status: Schema.Literals(["recorded", "capped", "unavailable"]),
  /** The blocker id, or `null` when nothing was recorded. */
  id: Schema.NullOr(Schema.String),
  /** Always a sentence the agent can act on, including on the refusal paths. */
  detail: Schema.String,
  /** Unanswered blockers on this thread after the call. */
  openBlockers: Schema.Number,
  /** The ceiling `openBlockers` is measured against. */
  cap: Schema.Number,
});

const LoopStatusResult = Schema.Struct({
  /** Supervised right now: armed, and not in a terminal state. */
  armed: Schema.Boolean,
  /** `no-loop` and `disabled` are the two ways `armed` is false without anything failing. */
  reason: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "off",
    "watching",
    "self_pacing",
    "standing_down",
    "held",
    "blocked",
    "stopped",
  ]),
  checkInsUsed: Schema.Number,
  maxCheckIns: Schema.Number,
  deadlineAtMs: Schema.Number,
  /** Clamped at 0. A passed deadline reads as no time left, never as negative time. */
  msToDeadline: Schema.Number,
  blockersOpen: Schema.Number,
});

const LoopDoneParams = Schema.Struct({
  reason: Schema.String.annotate({
    description: "One line on what you finished, or why you are stopping.",
  }),
});

const LoopDoneResult = Schema.Struct({
  /** True on every path: ending a run that was never supervised is a no-op, not a failure. */
  ok: Schema.Boolean,
  status: Schema.Literals(["recorded", "no-loop", "disabled"]),
  detail: Schema.String,
});

export const RaiseBlockerTool = Tool.make("raise_blocker", {
  description:
    "Bank a question for a human and keep working. Records the question against this thread and returns immediately — it does NOT wait for an answer, and answers arrive later in a check-in message. Use this instead of asking directly whenever stopping to ask would cost you the rest of an unattended run. Park that branch of the work and continue with something else.",
  parameters: RaiseBlockerParams,
  success: RaiseBlockerResult,
  dependencies,
})
  .annotate(Tool.Title, "Raise a blocker")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const LoopStatusTool = Tool.make("loop_status", {
  description:
    "Report this thread's supervision budget: whether a loop is armed, check-ins used against the budget, time left before the deadline, and how many raised blockers are still unanswered. Use it to scope how much work to take on before the run ends. Returns a status rather than an error when no loop is armed.",
  success: LoopStatusResult,
  dependencies,
})
  .annotate(Tool.Title, "Get loop status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LoopDoneTool = Tool.make("loop_done", {
  description:
    "Declare the supervised run finished, so no further check-ins are sent. Equivalent to writing .coil/loop-done in the working tree, which stays the primary contract because it works from a plain terminal. A no-op when no loop is armed.",
  parameters: LoopDoneParams,
  success: LoopDoneResult,
  dependencies,
})
  .annotate(Tool.Title, "End the loop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LoopToolkit = Toolkit.make(RaiseBlockerTool, LoopStatusTool, LoopDoneTool);

/** The three names, for the registration test and for anything listing the fork's tools. */
export const LOOP_TOOL_NAMES = ["raise_blocker", "loop_status", "loop_done"] as const;
