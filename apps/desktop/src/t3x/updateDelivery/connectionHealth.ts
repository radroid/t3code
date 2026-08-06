/**
 * Deciding when a push connection that *looks* alive is actually dead.
 *
 * This is the most important reliability rule in update delivery, and it is deliberately pure so
 * it can be tested without a socket.
 *
 * The motivating failure is not "the connection errored" — that case is easy and self-announcing.
 * It is the connection that survives laptop sleep, or a NAT rebind, or a Tailscale route change,
 * and comes back with the socket open, no error event, and no bytes ever again. A
 * reconnect-on-error ladder never fires for it. The app simply stops hearing about updates, for an
 * unbounded length of time, while reporting itself connected.
 *
 * This fork has already lived that failure once: issue #41, 103 minutes dark, silent throughout.
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
  const exponential = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_DELAY_MS);
  return Math.round(exponential * random());
}

/**
 * Every one of these re-reads `/latest` rather than trusting the stream.
 *
 * `power-resume` and `network-online` earn their place for the same reason the watchdog does:
 * after a sleep the stream may already be a corpse nobody has noticed, and waiting out the
 * watchdog to discover that is time spent knowingly stale. Being told by the OS that the world
 * changed beats inferring it from silence.
 *
 * There is no variant that trusts the stream instead, which is why this is a list rather than a
 * predicate — if a trigger is worth waking for, it is worth reconciling for.
 */
export type ReconciliationTrigger =
  | "startup"
  | "floor-poll"
  | "watchdog-fired"
  | "stream-closed"
  | "power-resume"
  | "network-online";
