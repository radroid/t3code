/**
 * The two question sections of the loop console: what stopped the loop, and what it worked
 * around.
 *
 * ## Why the blocking section does not mount the native card
 *
 * A native `AskUserQuestion` is already rendered, live and answerable, by
 * `ComposerPendingUserInputPanel` inside the composer — roughly fifty pixels below where this
 * overlay sits. Mounting a second instance here would render the identical card twice on one
 * screen, register a **second** document-level `1`–`9` keydown handler (so every digit key would
 * answer twice), and require ChatView-local draft state that the overlay could only reach by
 * widening `ChatView.tsx`, an existing seam row at churn 114.
 *
 * So this section **names** what is blocking and sends you to the control that already exists,
 * rather than duplicating it. The answer path is upstream's, unchanged, with one instance of it on
 * the page — which is also why there is no native half of `POST /api/coil/loop/answer`.
 *
 * The question text comes from the fork's own `userInputs` ledger rather than from the shell,
 * because that ledger is the only place a **voided** question is visible at all: upstream settles
 * pending inputs as empty answers during session teardown, after which `hasPendingUserInput` reads
 * false and a question nobody ever saw is indistinguishable from an answered one.
 *
 * @module coil/loop/LoopQuestions
 */

import { AlertTriangleIcon, ArrowDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";

import type { LoopBlocker, LoopUserInput, LoopView } from "./loopClient";
import {
  describeBlockingHint,
  formatAge,
  hasLoop,
  partitionBlockers,
  partitionUserInputs,
  resolveDeferredChannelNotice,
} from "./loopPresentation";

function SectionHeading({ title, why }: { readonly title: string; readonly why: string }) {
  return (
    <div className="mt-3 mb-1.5 flex items-baseline gap-2 first:mt-0">
      <h3 className="font-medium text-foreground text-xs">{title}</h3>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{why}</span>
    </div>
  );
}

/**
 * One boxed card.
 *
 * `bg-card` plus a border and a text label, deliberately with **no coloured leading rail**: the
 * rail in the prototype read as a status bar on a list rather than as a card, and it put four
 * hues on one small panel.
 */
function QuestionCard({
  label,
  labelClassName,
  at,
  nowMs,
  children,
}: {
  readonly label: string;
  readonly labelClassName?: string;
  readonly at: number;
  readonly nowMs: number;
  readonly children: React.ReactNode;
}) {
  return (
    <article className="mb-1.5 rounded-lg border border-border/60 bg-card p-2.5 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            "font-medium text-[10px] uppercase tracking-wide",
            labelClassName ?? "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
          {formatAge(at, nowMs)}
        </span>
      </div>
      {children}
    </article>
  );
}

function BlockingSection({ view, nowMs }: { readonly view: LoopView; readonly nowMs: number }) {
  const { open } = partitionUserInputs(view.record.userInputs);
  const hint = describeBlockingHint(view.derived);
  if (open.length === 0 && hint === null) return null;

  return (
    <section>
      <SectionHeading
        title="Stopped on these"
        why="the loop cannot go on until they are answered"
      />
      {open.map((entry) => (
        <QuestionCard
          key={entry.requestId}
          at={entry.raisedAtMs}
          label={entry.dialogKind === null ? "Question" : entry.dialogKind.replace(/_/g, " ")}
          labelClassName="text-foreground"
          nowMs={nowMs}
        >
          <p className="mt-1 text-[12.5px] leading-snug">{entry.question}</p>
        </QuestionCard>
      ))}
      {hint === null ? null : (
        <p className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
          {/* Pointing at the live control rather than cloning it — see the module note. The
              arrow only makes sense when the thing to do IS below; a snooze is undone
              elsewhere, so the copy says so and the arrow goes. */}
          {view.derived.reason === "snoozed" ? null : (
            <ArrowDownIcon aria-hidden="true" className="size-3 shrink-0" />
          )}
          {hint}
        </p>
      )}
    </section>
  );
}

function BlockerAnswerForm({
  blocker,
  onAnswer,
  busy,
}: {
  readonly blocker: LoopBlocker;
  readonly onAnswer: (answer: string) => void;
  readonly busy: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {blocker.options.map((option) => (
        <Button
          className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left"
          disabled={busy}
          key={option.label}
          onClick={() => onAnswer(option.label)}
          size="sm"
          variant="outline"
        >
          <span className="min-w-0">
            <span className="block font-medium text-xs">{option.label}</span>
            {option.description === "" ? null : (
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                {option.description}
              </span>
            )}
          </span>
        </Button>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() === "") return;
          onAnswer(text.trim());
          setText("");
        }}
      >
        <Input
          aria-label={`Answer: ${blocker.question}`}
          className="min-w-0 flex-1"
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          placeholder={blocker.options.length === 0 ? "Answer" : "…or in your own words"}
          size="sm"
          value={text}
        />
        <Button disabled={busy || text.trim() === ""} size="sm" type="submit" variant="outline">
          Send
        </Button>
      </form>
    </div>
  );
}

/**
 * The deferred channel.
 *
 * Three states, kept visibly distinct because they are different facts: **open** (nobody has
 * answered), **banked** (you answered, but the agent is idle and will not hear it until the next
 * check-in prompt), and **delivered** (the agent has been told).
 */
function DeferredSection({
  view,
  nowMs,
  browserAccessKnown,
  browserAccessEnabled,
  busyBlockerId,
  onAnswer,
}: {
  readonly view: LoopView;
  readonly nowMs: number;
  readonly browserAccessKnown: boolean;
  readonly browserAccessEnabled: boolean;
  readonly busyBlockerId: string | null;
  readonly onAnswer: (blockerId: string, answer: string) => void;
}) {
  const { open, banked, delivered } = partitionBlockers(view.record.blockers);
  // `loopExists` is what keeps this off every thread in the app: with no loop here nothing
  // would have used the channel, so the warning is noise rather than a fact about this thread.
  const notice = resolveDeferredChannelNotice({
    browserAccessKnown,
    browserAccessEnabled,
    loopExists: hasLoop(view),
  });
  if (notice === null && open.length === 0 && banked.length === 0 && delivered.length === 0) {
    return null;
  }

  return (
    <section>
      <SectionHeading
        title="Answer when you can"
        why="the loop worked around these and kept going"
      />
      {notice === null ? null : (
        <div className="mb-1.5 flex gap-2 rounded-lg border border-border/60 bg-card p-2.5">
          <AlertTriangleIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-amber-500"
          />
          <div className="min-w-0">
            <p className="font-medium text-xs">{notice.title}</p>
            <p className="mt-0.5 text-[11px]/4 text-muted-foreground">{notice.detail}</p>
          </div>
        </div>
      )}
      {open.map((blocker) => (
        <QuestionCard
          at={blocker.raisedAtMs}
          key={blocker.id}
          label="Blocker"
          labelClassName="text-foreground"
          nowMs={nowMs}
        >
          <p className="mt-1 text-[12.5px] leading-snug">{blocker.question}</p>
          {blocker.context === null ? null : (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{blocker.context}</p>
          )}
          <BlockerAnswerForm
            blocker={blocker}
            busy={busyBlockerId === blocker.id}
            onAnswer={(answer) => onAnswer(blocker.id, answer)}
          />
        </QuestionCard>
      ))}
      {[...banked, ...delivered].map((blocker) => (
        <QuestionCard
          at={blocker.answeredAtMs ?? blocker.raisedAtMs}
          key={blocker.id}
          label={blocker.deliveredToAgent ? "Answered · told the agent" : "Answered · not yet sent"}
          nowMs={nowMs}
        >
          <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
            {blocker.question}
          </p>
          <p className="mt-1 text-[12.5px] leading-snug">{blocker.answer}</p>
          {blocker.deliveredToAgent ? null : (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Banked. The next check-in restates it to the agent.
            </p>
          )}
        </QuestionCard>
      ))}
    </section>
  );
}

/**
 * Questions the runtime raised that nobody ever answered because the session was torn down.
 *
 * Rendered separately from "answered" on purpose: a voided question is a question the human never
 * saw, and folding it into the answered pile hides the only evidence it existed.
 */
function VoidedSection({
  voided,
  nowMs,
}: {
  readonly voided: ReadonlyArray<LoopUserInput>;
  readonly nowMs: number;
}) {
  if (voided.length === 0) return null;
  return (
    <section>
      <SectionHeading title="Never answered" why="the session ended while they were open" />
      {voided.map((entry) => (
        <QuestionCard key={entry.requestId} at={entry.raisedAtMs} label="Voided" nowMs={nowMs}>
          <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground line-through decoration-muted-foreground/40">
            {entry.question}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Closed by the session ending, not by an answer.
          </p>
        </QuestionCard>
      ))}
    </section>
  );
}

export interface LoopQuestionsProps {
  readonly view: LoopView;
  readonly nowMs: number;
  readonly browserAccessKnown: boolean;
  readonly browserAccessEnabled: boolean;
  readonly busyBlockerId: string | null;
  readonly onAnswer: (blockerId: string, answer: string) => void;
}

export function LoopQuestions(props: LoopQuestionsProps) {
  const { voided } = partitionUserInputs(props.view.record.userInputs);
  return (
    <>
      <BlockingSection nowMs={props.nowMs} view={props.view} />
      <DeferredSection
        browserAccessEnabled={props.browserAccessEnabled}
        browserAccessKnown={props.browserAccessKnown}
        busyBlockerId={props.busyBlockerId}
        nowMs={props.nowMs}
        onAnswer={props.onAnswer}
        view={props.view}
      />
      <VoidedSection nowMs={props.nowMs} voided={voided} />
    </>
  );
}
