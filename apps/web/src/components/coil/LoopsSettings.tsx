/**
 * Settings → Loops. Fork-owned, and deliberately not part of upstream's settings machinery.
 *
 * Loop state lives in `coil-loop.json` and is read and written through `/api/coil/loop/settings`,
 * so this panel touches neither `SettingsPanels.tsx` (churn 43) nor
 * `packages/contracts/src/settings.ts` (churn 38, persisted). The whole section costs the fork two
 * additive lines in `settingsSearch.ts` and two in `SettingsSidebarNav.tsx`, and nothing else.
 *
 * ## The master switch is a guard, not a lifecycle
 *
 * This is the one thing the copy here must get right. The supervisor always runs. Switching loops
 * off means nothing **fires**: every armed loop reports `standing_down` with reason `disabled`,
 * and **nothing is disarmed, nothing is stopped, no budget is spent or reset**. Switching it back
 * on resumes the same loops with the same budgets and the same deadlines. Wording it as an
 * on/off for loops *themselves* would teach people that flipping it cancels their overnight runs,
 * which is exactly what it does not do.
 *
 * The same rule covers the ceiling: lowering "Loops at once" below the number currently armed is
 * accepted, and the excess stand down at the next tick rather than being disarmed.
 *
 * @module coil/LoopsSettings
 */

import { Link } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "~/components/ui/number-field";
import { Switch } from "~/components/ui/switch";
import { LOOP_MAX_CHECK_INS, httpLoopClient } from "~/coil/loop/loopClient";
import type { LoopSettings, LoopView } from "~/coil/loop/loopClient";
import { describeLoopState, formatClock, summariseBounds } from "~/coil/loop/loopPresentation";
import { useLoopPolling } from "~/coil/loop/useLoopPolling";
import { usePrimaryEnvironmentId } from "~/state/environments";

const MINUTES = 60_000;
const HOURS = 3_600_000;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

function NumberSetting({
  label,
  value,
  min,
  max,
  disabled,
  suffix,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled: boolean;
  readonly suffix?: string;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberField
        className="w-20"
        disabled={disabled}
        format={NO_GROUPING}
        max={max}
        min={min}
        onValueCommitted={(next) => {
          if (next === null || !Number.isFinite(next)) return;
          onCommit(next);
        }}
        size="sm"
        value={value}
      >
        <NumberFieldGroup>
          <NumberFieldInput aria-label={label} />
        </NumberFieldGroup>
      </NumberField>
      {suffix === undefined ? null : (
        <span className="text-muted-foreground text-xs">{suffix}</span>
      )}
    </div>
  );
}

/**
 * "Did any of my runs give up overnight?" answered from one page.
 *
 * Arming is deliberately *not* here: it is a decision made at the moment you walk away from a
 * thread, not one made in Settings.
 */
function ArmedRoster({ loops }: { readonly loops: ReadonlyArray<LoopView> | null }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  if (loops === null) {
    return <p className="px-3 text-muted-foreground text-xs sm:px-4">Loading…</p>;
  }
  if (loops.length === 0) {
    return (
      <p className="px-3 text-muted-foreground text-xs sm:px-4">
        No loops are armed. Arm one from a thread, using the loop control above its composer.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1 px-3 sm:px-4">
      {loops.map((loop) => {
        const state = describeLoopState(loop.derived);
        return (
          <li
            className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
            key={loop.threadId}
          >
            <span className="min-w-0 flex-1">
              {primaryEnvironmentId === null ? (
                <span className="block truncate font-medium text-sm">
                  {loop.record.goal ?? loop.threadId}
                </span>
              ) : (
                <Link
                  className="block truncate font-medium text-sm hover:underline"
                  params={{ environmentId: primaryEnvironmentId, threadId: loop.threadId }}
                  to="/$environmentId/$threadId"
                >
                  {loop.record.goal ?? loop.threadId}
                </Link>
              )}
              <span className="block truncate text-muted-foreground text-xs">{state.label}</span>
            </span>
            <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
              {summariseBounds(loop.derived)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function LoopsSettingsPanel() {
  const loadSettings = useCallback(() => httpLoopClient.readSettings(), []);
  const settings = useLoopPolling<LoopSettings>("global", loadSettings);
  const loadLoops = useCallback(() => httpLoopClient.listLoops(), []);
  const loops = useLoopPolling<ReadonlyArray<LoopView>>("loops", loadLoops);

  const value = settings.value;
  const patch = useCallback(
    (next: Partial<Omit<LoopSettings, "armedCount">>) => {
      void httpLoopClient.writeSettings(next).then((result) => {
        if (result === null || !result.ok) {
          // The server refused or is unreachable; re-read rather than leaving an optimistic lie
          // on screen.
          settings.refresh();
          return;
        }
        settings.set(result.value);
        loops.refresh();
      });
    },
    [loops, settings],
  );

  const disabled = value === null;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Loops">
        <SettingsRow
          {...searchableSetting("loops-enabled")}
          control={
            <Switch
              aria-label="Let threads run as loops"
              checked={value?.enabled ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => patch({ enabled: Boolean(checked) })}
            />
          }
          description="A loop keeps one thread working while you are away and collects what it needs from you in one place. This switch is a guard, not a lifecycle: with it off nothing fires, and armed loops stand down keeping their budget and deadline. Nothing is disarmed and nothing is stopped."
          status={
            value === null
              ? undefined
              : `${value.armedCount} of ${value.maxArmedThreads} loops armed right now.`
          }
        />
        <SettingsRow
          description="Ceiling across every project. Three loops at six check-ins is eighteen unattended turns a night. Lowering it below the number already armed is allowed — the excess stand down, they are not disarmed."
          id="loop-ceiling"
          title="Loops at once"
          control={
            <NumberSetting
              disabled={disabled}
              label="Loops at once"
              max={100}
              min={1}
              onCommit={(next) => patch({ maxArmedThreads: next })}
              value={value?.maxArmedThreads ?? 3}
            />
          }
        />
      </SettingsSection>

      <SettingsSection {...searchableSetting("loop-defaults")}>
        <SettingsRow
          description="How long a thread may go completely silent before a loop checks in on it."
          id="loop-idle"
          title="Check in after"
          control={
            <NumberSetting
              disabled={disabled}
              label="Check in after"
              max={720}
              min={1}
              onCommit={(next) => patch({ defaultIdleMs: next * MINUTES })}
              suffix="min"
              value={Math.round((value?.defaultIdleMs ?? 15 * MINUTES) / MINUTES)}
            />
          }
        />
        <SettingsRow
          description="A longer fuse while a turn still looks busy. A repo whose suite runs forty minutes needs a different number from a docs thread. It lengthens the fuse; it never vetoes a check-in."
          id="loop-busy-idle"
          title="…if a turn still looks busy"
          control={
            <NumberSetting
              disabled={disabled}
              label="Check in after, while busy"
              max={720}
              min={1}
              onCommit={(next) => patch({ defaultBusyIdleMs: next * MINUTES })}
              suffix="min"
              value={Math.round((value?.defaultBusyIdleMs ?? 45 * MINUTES) / MINUTES)}
            />
          }
        />
        <SettingsRow
          description={`Hard cap on how many times one loop may restart a thread. There is no unlimited option, deliberately. The most a single run may spend is ${LOOP_MAX_CHECK_INS}.`}
          id="loop-budget"
          title="Check-in budget"
          control={
            <NumberSetting
              disabled={disabled}
              label="Check-in budget"
              max={LOOP_MAX_CHECK_INS}
              min={1}
              onCommit={(next) => patch({ defaultMaxCheckIns: next })}
              value={value?.defaultMaxCheckIns ?? 6}
            />
          }
        />
        <SettingsRow
          description="How far ahead the deadline is set when you arm a loop. It seeds the form only — a run always ends at the absolute time you chose, and a loop with no deadline is refused rather than given a default one."
          id="loop-run-length"
          title="Run for"
          control={
            <NumberSetting
              disabled={disabled}
              label="Run for"
              max={168}
              min={1}
              onCommit={(next) => patch({ defaultRunMs: next * HOURS })}
              suffix="hours"
              value={Math.round((value?.defaultRunMs ?? 8 * HOURS) / HOURS)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="loop-roster"
        title="Armed right now"
        headerAction={
          value === null ? null : (
            <span className="text-muted-foreground text-xs">
              {value.armedCount} of {value.maxArmedThreads} used
            </span>
          )
        }
      >
        <ArmedRoster loops={loops.value} />
        {loops.lastLoadedAtMs === null ? null : (
          <p className="px-3 text-[11px] text-muted-foreground/80 sm:px-4">
            Updated {formatClock(loops.lastLoadedAtMs)}
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
