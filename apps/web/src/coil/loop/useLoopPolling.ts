/**
 * The fetch cadence every loop surface shares: poll every 30s, and again on window focus.
 *
 * Same shape as the auto-resume overlay's, and for the same reasons — a fork route is not on the
 * websocket, so there is nothing to subscribe to, and 30s is slow enough to be invisible on the
 * wire while a focus refresh covers the case that actually matters (you come back to the machine
 * at 9am and want today's answer, not last night's).
 *
 * **No spinner.** A loop that has not moved for eight hours is not "loading", and a spinner over
 * it would be a lying one. Callers render `lastLoadedAtMs` instead, so the console says when it
 * last heard from the server rather than pretending to be busy.
 *
 * @module coil/loop/useLoopPolling
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const LOOP_POLL_INTERVAL_MS = 30_000;

export interface PolledResource<A> {
  /** `null` means "we do not know" — never "there is nothing". */
  readonly value: A | null;
  /** When the last successful load landed, for an honest "Updated …" label. */
  readonly lastLoadedAtMs: number | null;
  readonly refresh: () => void;
  /** Apply a value the caller already has in hand (e.g. the body of a write response). */
  readonly set: (value: A) => void;
}

/**
 * Polls `load`, discarding any response that lands after `key` changed.
 *
 * `key` is the identity of the thing being loaded (a threadId, or a constant for a global
 * resource). Changing it clears the value first, so a slow in-flight read for the previous thread
 * can never populate the new one.
 */
export function useLoopPolling<A>(key: string, load: () => Promise<A | null>): PolledResource<A> {
  const [value, setValue] = useState<A | null>(null);
  const [lastLoadedAtMs, setLastLoadedAtMs] = useState<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Bumped on every key change; a late response carrying a stale token is dropped.
  const tokenRef = useRef(0);

  const refresh = useCallback(() => {
    const token = tokenRef.current;
    void loadRef.current().then(
      (next) => {
        if (token !== tokenRef.current || next === null) return;
        setValue(next);
        setLastLoadedAtMs(Date.now());
      },
      () => {
        // `load` resolves to null on failure; a rejection here is still non-fatal.
      },
    );
  }, []);

  useEffect(() => {
    tokenRef.current += 1;
    setValue(null);
    setLastLoadedAtMs(null);
    refresh();

    const intervalId = window.setInterval(refresh, LOOP_POLL_INTERVAL_MS);
    const handleFocus = () => refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [key, refresh]);

  const set = useCallback((next: A) => {
    setValue(next);
    setLastLoadedAtMs(Date.now());
  }, []);

  return { value, lastLoadedAtMs, refresh, set };
}
