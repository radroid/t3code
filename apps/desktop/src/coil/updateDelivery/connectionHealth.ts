/**
 * Deciding when a push connection that *looks* alive is actually dead, kept pure so it is testable
 * without a socket. The failure that matters is the socket that survives sleep, a NAT rebind or a
 * route change with no error and no bytes ever again: reconnect-on-error never fires, and the app
 * stops hearing about updates indefinitely while reporting itself connected.
 */

/** Server sends `: ping` at this interval. Must match `HEARTBEAT_INTERVAL_MS` in the relay. */
export const SERVER_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Declare the stream dead after 2.5 missed heartbeats.
 *
 * Two would be too eager — one dropped ping under load would churn the connection. Three or more
 * pushes detection past a minute for no benefit, given reconnecting is nearly free.
 */
export const WATCHDOG_TIMEOUT_MS = SERVER_HEARTBEAT_INTERVAL_MS * 2.5;

/**
 * Poll `/latest` this often no matter how healthy the stream looks.
 *
 * The floor is what makes the worst case bounded instead of unbounded. Even if every heuristic
 * above is wrong, and the watchdog somehow does not fire, staleness cannot exceed this. It is the
 * difference between "we might miss an update for a while" and the #41 outage.
 */
export const FLOOR_POLL_INTERVAL_MS = 15 * 60_000;

/** Reconnect backoff. Capped low because the relay closes streams every 15 min by design. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;

export type ConnectionVerdict =
  | { readonly kind: "healthy" }
  | { readonly kind: "stale"; readonly silentForMs: number };

/**
 * Any byte counts, including a heartbeat comment.
 *
 * The heartbeat exists solely so that "no bytes" means something. Without it, a genuinely idle
 * channel — no releases for an hour — is indistinguishable from a dead socket, and any watchdog
 * built on it would either fire constantly or never.
 */
export function assessConnection(args: {
  readonly lastByteAtMs: number;
  readonly nowMs: number;
  readonly timeoutMs?: number;
}): ConnectionVerdict {
  const timeoutMs = args.timeoutMs ?? WATCHDOG_TIMEOUT_MS;
  const silentForMs = args.nowMs - args.lastByteAtMs;
  return silentForMs > timeoutMs ? { kind: "stale", silentForMs } : { kind: "healthy" };
}

/**
 * Exponential backoff with full jitter.
 *
 * Jittered because every desktop app on the fleet is woken by the same events — a relay deploy, a
 * laptop lid opening on a Monday morning — and unjittered backoff would reconnect them all in
 * lockstep, turning a blip into a thundering herd against a single Durable Object.
 */
export function reconnectDelayMs(attempt: number, random: () => number): number {
  const exponential = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
    RECONNECT_MAX_DELAY_MS,
  );
  return Math.round(exponential * random());
}

/**
 * A stream that lasted this long was working, whatever ended it.
 *
 * Comfortably longer than an instant reject and comfortably shorter than the relay's 15-minute
 * cap, so a healthy connection always resets the backoff and a flapping one never does.
 */
export const HEALTHY_STREAM_MS = 60_000;

/** Caps the exponent. `reconnectDelayMs` already clamps the delay; this stops the counter growing. */
export const MAX_BACKOFF_ATTEMPT = 16;

/**
 * The next backoff attempt, decided by how long the last connection lasted, **not** by why it
 * ended. The relay closes every connection at fifteen minutes, so `stream-closed` is also what an
 * instant drop reports; resetting on the reason would hot-loop every installed app against a
 * single Durable Object.
 */
export function nextBackoffAttempt(attempt: number, lastedMs: number): number {
  if (lastedMs >= HEALTHY_STREAM_MS) return 0;
  return Math.min(attempt + 1, MAX_BACKOFF_ATTEMPT);
}

/**
 * Every trigger except `push` re-reads `/latest` rather than trusting the stream. `power-resume`
 * and `network-online` exist because after a sleep the stream may already be dead unnoticed, and
 * being told by the OS beats waiting out the watchdog.
 */
export type ReconciliationTrigger =
  /**
   * A frame arrived on the open stream. The only trigger that does NOT re-read `/latest` — the
   * frame carries the whole manifest, and the relay serves the same bytes on both endpoints.
   */
  | "push"
  | "startup"
  | "floor-poll"
  | "watchdog-fired"
  | "stream-closed"
  | "power-resume"
  | "network-online";
