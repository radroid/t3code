import type { ProviderDriverKind } from "@t3tools/contracts";

/**
 * Which provider drivers can take a message *during* a running turn.
 *
 * A `sendTurn` that arrives while a turn is already running is a "steer": the
 * adapter folds the message into the live agent loop and the work continues as
 * the same turn, which is what typing into the Claude Code CLI while it works
 * does. Nothing above the adapter blocks it — upstream's immediate-send path
 * has no `phase === "running"` guard, the decider has no running-turn
 * invariant, and `ProviderService.sendTurn` has no busy check.
 *
 * The catch is that there is no steering capability flag anywhere in the
 * contracts, so support is implicit per adapter and has to be asserted here.
 * This list is therefore an allowlist, not a denylist: a driver only steers if
 * it is named below, and anything unrecognised falls back to the outbox. That
 * matters because a refused steer is invisible — `providerService.sendTurn` is
 * `Effect.forkScoped` in ProviderCommandReactor, so the client's command has
 * already succeeded by then; the message is persisted, the composer is
 * cleared, and the only trace is a `provider.turn.start.failed` activity.
 * Failing closed costs a queued message; failing open loses one.
 *
 * Verified against each adapter's `sendTurn`, all of which reuse the running
 * turn's id and emit no second `turn.started`:
 *
 * - `claudeAgent` — ClaudeAdapter.ts:3729, covered by ClaudeAdapter.test.ts:976
 *   ("steers a running turn instead of opening a new one on mid-turn
 *   sendTurn"). One long-lived `query()` per thread whose prompt is a stream
 *   fed from a queue, so the message reaches the CLI's stdin immediately.
 * - `cursor` — CursorAdapter.ts:916, covered by CursorAdapter.test.ts:253.
 * - `grok` — GrokAdapter.ts:921.
 * - `opencode` — OpenCodeAdapter.ts:1417, covered by OpenCodeAdapter.test.ts:733.
 *
 * Deliberately absent:
 *
 * - `codex` — CodexSessionRuntime.ts:1305 issues `turn/start` unconditionally
 *   and overwrites `activeTurnId` with the response's turn id. The Codex
 *   app-server protocol does expose a real `turn/steer` RPC, but t3code never
 *   calls it, so any folding is the app-server's own decision rather than
 *   something this repo implements. Its `activeTurnNotSteerable` error (raised
 *   during `/review` or a manual `/compact`) is not handled either.
 */
const STEERABLE_PROVIDER_DRIVER_KINDS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
]);

export function providerSupportsSteering(driver: ProviderDriverKind | null | undefined): boolean {
  return driver !== null && driver !== undefined && STEERABLE_PROVIDER_DRIVER_KINDS.has(driver);
}

/**
 * Whether the active thread is busy in a way the provider can absorb right now,
 * so a submit should go out immediately instead of into the outbox.
 *
 * Only a running turn qualifies:
 *
 * - `isSendBusy` is the optimistic local-dispatch window. Upstream's
 *   immediate-send path bails on it, so a submit made here would be silently
 *   dropped rather than sent — queuing keeps the message.
 * - `isRevertingCheckpoint` is not a provider turn at all; there is nothing to
 *   steer into.
 */
export function canSteerActiveThread(input: {
  readonly phase: string;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly provider: ProviderDriverKind | null | undefined;
}): boolean {
  return (
    input.phase === "running" &&
    !input.isSendBusy &&
    !input.isRevertingCheckpoint &&
    providerSupportsSteering(input.provider)
  );
}
