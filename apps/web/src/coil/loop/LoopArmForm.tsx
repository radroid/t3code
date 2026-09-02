/**
 * Arm, re-arm, edit and disarm — the four writes the console makes.
 *
 * **No validation lives here.** The bounds are the server's: `maxCheckIns` outside 1..20 and a
 * deadline in the past are 400s with distinct codes, deliberately never clamped, because a silent
 * clamp turns a typo into an overnight bill and hides it. This form therefore submits what was
 * typed and renders the refusal it gets back, code and all. Duplicating the rules client-side
 * would make the browser and the server two sources of truth for a money-spending bound.
 *
 * The deadline is picked as a wall-clock time in the reader's own timezone and sent as an absolute
 * instant; the server never stores anything else.
 *
 * @module coil/loop/LoopArmForm
 */

import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { LOOP_MAX_CHECK_INS, type LoopView, type LoopWriteBody } from "./loopClient";
import { fromDateTimeLocalValue, seedArmDraft, toDateTimeLocalValue } from "./loopPresentation";

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-medium text-[11px] text-muted-foreground">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="text-[10.5px] text-muted-foreground/80">{hint}</span>
      )}
    </label>
  );
}

export interface LoopArmFormProps {
  readonly view: LoopView;
  readonly defaultMaxCheckIns: number;
  readonly defaultRunMs: number;
  readonly busy: boolean;
  readonly onSubmit: (body: Omit<LoopWriteBody, "threadId">) => void;
}

export function LoopArmForm({
  view,
  defaultMaxCheckIns,
  defaultRunMs,
  busy,
  onSubmit,
}: LoopArmFormProps) {
  const armed = view.record.armed;
  const stopped = view.record.stopped !== null;
  // Seeded once. The caller keys this component on the threadId, so switching threads remounts it
  // with fresh values while a 30s poll landing mid-edit can never rewrite what is being typed.
  const [draft, setDraft] = useState(() =>
    seedArmDraft({
      settings: {
        enabled: true,
        maxArmedThreads: 0,
        defaultMaxCheckIns,
        defaultRunMs,
        defaultIdleMs: 0,
        defaultBusyIdleMs: 0,
        armedCount: 0,
      },
      record: view.record,
      nowMs: Date.now(),
    }),
  );

  const action = armed ? "edit" : stopped ? "rearm" : "arm";
  const submitLabel = armed ? "Save bounds" : stopped ? "Give it another run" : "Arm loop";

  return (
    <form
      className="mt-2 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          action,
          goal: draft.goal.trim() === "" ? null : draft.goal.trim(),
          maxCheckIns: draft.maxCheckIns,
          // Sent even when it did not change: `edit` re-validates whatever it is given, and an
          // omitted deadline on an `arm` is `deadline_required`, never a default.
          deadlineAtMs: draft.deadlineAtMs,
        });
      }}
    >
      <Field label="What it is working on" hint="Restated to the agent at every check-in.">
        <Input
          className="w-full"
          onChange={(event) => setDraft((previous) => ({ ...previous, goal: event.target.value }))}
          placeholder="Finish the auth refactor"
          size="sm"
          value={draft.goal}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Check-ins" hint={`1–${LOOP_MAX_CHECK_INS}. No unlimited option.`}>
          <Input
            className="w-full"
            inputMode="numeric"
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                maxCheckIns: Number.parseInt(event.target.value, 10),
              }))
            }
            size="sm"
            type="number"
            value={Number.isFinite(draft.maxCheckIns) ? String(draft.maxCheckIns) : ""}
          />
        </Field>
        <Field label="Stop by" hint="Your timezone.">
          <Input
            className="w-full"
            nativeInput
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                deadlineAtMs: fromDateTimeLocalValue(event.target.value) ?? Number.NaN,
              }))
            }
            size="sm"
            type="datetime-local"
            value={
              Number.isFinite(draft.deadlineAtMs) ? toDateTimeLocalValue(draft.deadlineAtMs) : ""
            }
          />
        </Field>
      </div>
      <div className="flex items-center gap-1.5">
        <Button disabled={busy} size="sm" type="submit">
          {submitLabel}
        </Button>
        {armed ? (
          // The way out, always present while armed. A one-way door is a bug.
          <Button
            disabled={busy}
            onClick={() => onSubmit({ action: "disarm" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Disarm
          </Button>
        ) : null}
        {stopped ? (
          // The other way out. Without it a finished run's pill and bounds sit above the
          // composer forever, and the only way to dismiss them is to start another run —
          // which is the one-way door pointing the other way.
          <Button
            disabled={busy}
            onClick={() => onSubmit({ action: "clear" })}
            size="sm"
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}
