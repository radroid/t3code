/**
 * The loop console — the standing answer to "what do you need from me?".
 *
 * An **overlay on the thread route**, not a second default view: the transcript stays what you
 * land on. That is a declared divergence from the original ask (PLAN §3, FINDINGS §F1) and the
 * reason is that a second default view has nothing to toggle back from — it needs a sticky
 * per-thread toggle that survives reload, agrees across two windows, and is discoverable when it
 * is wrong, and choosing the view means owning the thread route's render decision, which is
 * `ChatView.tsx` territory rather than the delta-zero overlay row.
 *
 * Sits above the docked composer, mirroring its box through the shared `useComposerAnchor`, and
 * left-aligned so it never collides with the auto-resume capsule on the right.
 *
 * ## Two rules the rendering obeys
 *
 * **No spinner, and no repainting clock.** Deadlines are absolute (`ends 07:00`), ages are
 * computed once per poll rather than once per second, and the panel says when it last heard from
 * the server instead of pretending to be busy. A spinner over a run that has not moved in eight
 * hours is a lying one, and a per-second repaint on a high-refresh display is a GPU cost for
 * nothing.
 *
 * **`spent` is never green.** The tone comes from `describeLoopState`, where the distinction
 * between "it finished" and "it ran out of rope" is pinned by tests.
 *
 * @module coil/loop/LoopConsole
 */

import { ChevronDownIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { usePrimarySettings, usePrimarySettingsAvailable } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { useComposerAnchor } from "../composerAnchor";
import { LoopArmForm } from "./LoopArmForm";
import { LoopQuestions } from "./LoopQuestions";
import type { LoopSettings, LoopView, LoopWriteBody } from "./loopClient";
import { httpLoopClient } from "./loopClient";
import type { LoopTone } from "./loopPresentation";
import {
  canRenderLoopConsole,
  countWaiting,
  describeCheckInRow,
  describeEmptyState,
  describeLoopState,
  describeRefusal,
  formatAge,
  formatClock,
  hasLoop,
  hasQuestionSections,
  summariseBounds,
} from "./loopPresentation";
import { useLoopPolling } from "./useLoopPolling";

const TONE_DOT: Readonly<Record<LoopTone, string>> = {
  muted: "bg-muted-foreground/50",
  active: "bg-sky-500",
  attention: "bg-primary",
  held: "bg-amber-500",
  done: "bg-emerald-500",
  // Zinc. Never emerald — an exhausted run must not read as a finished one.
  spent: "bg-zinc-400",
};

const TONE_TEXT: Readonly<Record<LoopTone, string>> = {
  muted: "text-muted-foreground",
  active: "text-foreground",
  attention: "text-foreground",
  held: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
  spent: "text-zinc-500 dark:text-zinc-400",
};

const DEGRADED_COPY: Readonly<Record<"gate_off" | "wake_lost", string>> = {
  gate_off:
    "The agent's own scheduler reported itself off, so T3 is the only thing waking this thread.",
  wake_lost:
    "A wake the agent scheduled never landed — T3 covered it. That is the gap this loop exists for.",
};

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="truncate text-xs">{value}</dd>
    </div>
  );
}

export interface LoopConsoleProps {
  readonly threadRef: { readonly environmentId: string; readonly threadId: string };
}

export function LoopConsole({ threadRef }: LoopConsoleProps) {
  const threadId = threadRef.threadId;
  const [expanded, setExpanded] = useState(false);
  const [anchorElement, setAnchorElement] = useState<HTMLDivElement | null>(null);
  const anchor = useComposerAnchor(anchorElement);
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const [busyBlockerId, setBusyBlockerId] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const browserAccessKnown = usePrimarySettingsAvailable();
  const browserAccessEnabled = usePrimarySettings((settings) => settings.enableAgentBrowserAccess);

  // Every fork route is called against the primary environment, so on a thread that belongs
  // to another one the console would answer for a thread id that server has never heard of.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const consoleTargetsThisThread = canRenderLoopConsole({
    primaryEnvironmentId,
    threadEnvironmentId: threadRef.environmentId,
  });

  const loadView = useCallback(() => httpLoopClient.read(threadId), [threadId]);
  const loop = useLoopPolling<LoopView>(threadId, loadView);
  const loadSettings = useCallback(() => httpLoopClient.readSettings(), []);
  const settings = useLoopPolling<LoopSettings>("global", loadSettings);

  useEffect(() => {
    setExpanded(false);
    setRefusal(null);
  }, [threadId]);

  const applyResult = useCallback(
    (result: Awaited<ReturnType<typeof httpLoopClient.write>>) => {
      if (result === null) return;
      if (result.ok) {
        setRefusal(null);
        loop.set(result.value);
        return;
      }
      setRefusal(describeRefusal(result.code));
    },
    [loop],
  );

  const handleWrite = useCallback(
    (body: Omit<LoopWriteBody, "threadId">) => {
      setWriting(true);
      void httpLoopClient.write({ threadId, ...body }).then(
        (result) => {
          setWriting(false);
          applyResult(result);
        },
        () => setWriting(false),
      );
    },
    [applyResult, threadId],
  );

  const handleAnswer = useCallback(
    (blockerId: string, answer: string) => {
      setBusyBlockerId(blockerId);
      void httpLoopClient.answer({ threadId, blockerId, answer }).then(
        (result) => {
          setBusyBlockerId(null);
          if (result === null) return;
          if (result.ok) {
            setRefusal(null);
            // The answer route returns `{ ok: true }` and nothing else, so re-read rather than
            // guessing what the record now looks like.
            loop.refresh();
            return;
          }
          setRefusal(describeRefusal(result.code));
        },
        () => setBusyBlockerId(null),
      );
    },
    [loop, threadId],
  );

  const view = loop.value;
  // One clock read per load, not one per second. Every age in the panel is relative to it.
  const nowMs = loop.lastLoadedAtMs ?? 0;
  const state = useMemo(
    () => (view === null ? null : describeLoopState(view.derived, nowMs)),
    [nowMs, view],
  );
  const waiting = view === null ? 0 : countWaiting(view);

  if (view === null || state === null || !consoleTargetsThisThread) {
    return null;
  }

  const empty = describeEmptyState(view, nowMs);
  const hasQuestions = hasQuestionSections(view, { browserAccessKnown, browserAccessEnabled });

  return (
    <div
      // Same measured box as the auto-resume capsule, so the two sit on one line above the
      // composer card; `items-start` keeps this one on the left and that one on the right.
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
      <div className="mx-auto flex w-full max-w-3xl flex-col-reverse items-start gap-1.5">
        <Collapsible
          className="flex max-w-full flex-col-reverse items-start gap-1.5"
          onOpenChange={setExpanded}
          open={expanded}
        >
          <CollapsibleTrigger
            aria-label={expanded ? "Hide the loop console" : "Show the loop console"}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card py-0.5 pr-1.5 pl-2 text-xs shadow-sm"
          >
            <span
              aria-hidden="true"
              className={cn("size-1.5 rounded-full", TONE_DOT[state.tone])}
            />
            <span className={cn("font-medium", TONE_TEXT[state.tone])}>{state.label}</span>
            {hasLoop(view) ? (
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {summariseBounds(view.derived, nowMs)}
              </span>
            ) : null}
            {waiting > 0 ? (
              <span className="rounded-full bg-primary/16 px-1.5 font-medium text-[10px] text-primary">
                {waiting}
              </span>
            ) : null}
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
                expanded ? "rotate-0" : "rotate-180",
              )}
            />
          </CollapsibleTrigger>

          <CollapsiblePanel className="pointer-events-auto">
            <div className="max-h-[60vh] w-88 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border/60 bg-card p-3 shadow-md">
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 truncate font-medium text-xs">{view.record.goal ?? "Loop"}</p>
                {/* An honest staleness label, not a spinner. */}
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {loop.lastLoadedAtMs === null
                    ? ""
                    : `Updated ${formatClock(loop.lastLoadedAtMs)}`}
                </span>
              </div>
              <p className="mt-0.5 text-[11px]/4 text-muted-foreground">{state.detail}</p>

              {refusal === null ? null : (
                <div className="mt-2 rounded-lg border border-destructive/30 bg-card p-2.5">
                  <p className="text-xs">{refusal.message}</p>
                  {/* The server's own code, carried verbatim: it is what makes an unrecognised
                      refusal reportable rather than a blank failure. */}
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {refusal.code}
                  </p>
                </div>
              )}

              {hasQuestions ? (
                <LoopQuestions
                  browserAccessEnabled={browserAccessEnabled}
                  browserAccessKnown={browserAccessKnown}
                  busyBlockerId={busyBlockerId}
                  nowMs={nowMs}
                  onAnswer={handleAnswer}
                  view={view}
                />
              ) : (
                <div className="mt-3 rounded-lg border border-border/60 bg-card p-2.5">
                  <p className="font-medium text-xs">{empty.headline}</p>
                  {empty.lines.map((line) => (
                    <p className="mt-0.5 text-[11px]/4 text-muted-foreground" key={line}>
                      {line}
                    </p>
                  ))}
                </div>
              )}

              {hasLoop(view) ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                    <Fact
                      label="Check-ins"
                      value={`${view.derived.checkInsUsed} of ${view.derived.maxCheckIns}`}
                    />
                    <Fact
                      label="Stops by"
                      value={
                        view.derived.deadlineAtMs > 0
                          ? formatClock(view.derived.deadlineAtMs, nowMs)
                          : "not set"
                      }
                    />
                    <Fact
                      label="Loops armed"
                      value={`${view.derived.armedCount} of ${view.derived.maxArmedThreads}`}
                    />
                    <Fact
                      label="Next own wake"
                      value={
                        view.derived.nextWakeAtMs === null
                          ? "none recorded"
                          : formatClock(view.derived.nextWakeAtMs, nowMs)
                      }
                    />
                  </dl>
                  {view.record.degraded === null ? null : (
                    <p className="mt-2 text-[11px]/4 text-muted-foreground">
                      {DEGRADED_COPY[view.record.degraded]}
                    </p>
                  )}
                </>
              ) : null}

              {view.record.checkIns.length === 0 ? null : (
                <section className="mt-3">
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <h3 className="font-medium text-foreground text-xs">Check-ins</h3>
                    <span className="text-[11px] text-muted-foreground">
                      what the loop did each time it woke
                    </span>
                  </div>
                  <ol className="flex flex-col gap-1">
                    {view.record.checkIns.toReversed().map((row) => (
                      <li
                        className="flex items-baseline gap-2 rounded-md px-0.5 text-[11px]"
                        key={`${row.n}-${row.firedAtMs}`}
                      >
                        <span className="font-mono text-muted-foreground tabular-nums">
                          #{row.n}
                        </span>
                        <span className="min-w-0 flex-1">{describeCheckInRow(row)}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatAge(row.firedAtMs, nowMs)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <LoopArmForm
                busy={writing}
                key={view.threadId}
                defaultMaxCheckIns={settings.value?.defaultMaxCheckIns ?? 6}
                defaultRunMs={settings.value?.defaultRunMs ?? 8 * 3_600_000}
                onSubmit={handleWrite}
                view={view}
              />

              {view.derived.globalEnabled ? null : (
                <p className="mt-2 text-[11px]/4 text-muted-foreground">
                  Loops are switched off in Settings → Loops. Arming still works; nothing will fire
                  until the master switch is on.
                </p>
              )}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </div>
  );
}
