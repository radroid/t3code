/*
 * Types for windows-exit-codes.mjs. Hand-written for the same reason as
 * render-release-notes.d.mts: the implementation is `.mjs` so the release workflow can run it on
 * the runner image's Node, and this package's tsconfig does not set `allowJs`.
 */

export interface WindowsStatus {
  /** NTSTATUS symbol, as documented by Microsoft. */
  readonly name: string;
  /** The value as an unsigned 32-bit integer — the hex spelling Windows itself uses. */
  readonly unsigned: number;
  /** The same value as Node reports a child's status: signed 32-bit. */
  readonly signed: number;
  /** Whether another attempt is reasonable. */
  readonly transient: boolean;
  readonly meaning: string;
  readonly advice: string;
}

export const WINDOWS_FATAL_STATUSES: readonly WindowsStatus[];

export function describeWindowsExitCode(code: number | string): WindowsStatus | undefined;

export function findWindowsFatalStatuses(logText: string): readonly WindowsStatus[];

export function isTransientProcessStartFailure(logText: string): boolean;

export function explainWindowsFailure(logText: string): string;
