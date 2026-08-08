/**
 * Framework-free lifecycle machine behind the auto-resume overlay.
 *
 * Everything that used to live as refs and effects inside `AutoResumeOverlay.tsx` lives here
 * instead: poll gating, optimistic toggling, in-flight write accounting, prompt debouncing, and
 * flush-on-thread-change. The component keeps only DOM concerns (timers wired to `window`, focus
 * listeners, layout), which is what makes the tricky paths reachable from a test without a DOM.
 *
 * The client and the timers are injected so tests drive both the network and the clock.
 *
 * @module t3x/autoResumeController
 */

import type { AutoResumeClient, AutoResumeState, AutoResumeWrite } from "./autoResumeClient";

export const PROMPT_DEBOUNCE_MS = 600;

export interface AutoResumeTimers {
  readonly setTimeout: (handler: () => void, timeoutMs: number) => number;
  readonly clearTimeout: (handle: number) => void;
}

const defaultTimers: AutoResumeTimers = {
  setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export interface AutoResumeSnapshot {
  readonly state: AutoResumeState | null;
  readonly promptDraft: string;
}

export interface AutoResumeControllerOptions {
  readonly client: AutoResumeClient;
  readonly timers?: AutoResumeTimers;
  readonly promptDebounceMs?: number;
}

export interface AutoResumeController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AutoResumeSnapshot;
  /** Point the controller at a thread (or `null` to idle). Flushes any debounced edit first. */
  readonly setThread: (threadId: string | null) => void;
  /** Poll tick / window focus. A no-op while a write is in flight. */
  readonly refresh: () => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly setPromptDraft: (value: string) => void;
  readonly dispose: () => void;
}

function normalizeOverridePrompt(value: string): string | null {
  return value.trim() === "" ? null : value;
}

const EMPTY_SNAPSHOT: AutoResumeSnapshot = { state: null, promptDraft: "" };

export function createAutoResumeController(
  options: AutoResumeControllerOptions,
): AutoResumeController {
  const { client } = options;
  const timers = options.timers ?? defaultTimers;
  const promptDebounceMs = options.promptDebounceMs ?? PROMPT_DEBOUNCE_MS;

  const listeners = new Set<() => void>();

  let threadId: string | null = null;
  let state: AutoResumeState | null = null;
  /** `null` until the first load lands, so a poll can seed it without clobbering typing. */
  let promptDraft: string | null = null;
  let disposed = false;

  /**
   * Bumped on every thread change so an in-flight read that resolves late is discarded instead of
   * populating the overlay with another thread's state.
   */
  let loadToken = 0;
  /**
   * In-flight writes counted **per thread**, not globally.
   *
   * The count exists to stop a poll overwriting an optimistic value that has not round-tripped —
   * a same-thread concern. A global counter also blocked the *initial load of a different thread*,
   * so switching threads mid-write left the overlay invisible until the next 30s poll.
   */
  const inFlightWrites = new Map<string, number>();
  let promptTimer: number | null = null;
  /** The edit a debounced write is waiting to send, kept so it can be flushed rather than dropped. */
  let pendingPrompt: { readonly threadId: string; readonly value: string } | null = null;

  /**
   * Cached because `useSyncExternalStore` calls `getSnapshot` on every render and compares by
   * reference — returning a fresh object each time is an infinite render loop.
   */
  let snapshot: AutoResumeSnapshot = EMPTY_SNAPSHOT;

  const emit = () => {
    const nextDraft = promptDraft ?? "";
    if (snapshot.state === state && snapshot.promptDraft === nextDraft) {
      return;
    }
    snapshot = { state, promptDraft: nextDraft };
    for (const listener of listeners) {
      listener();
    }
  };

  /**
   * Issues a write and guarantees the in-flight counter is released exactly once.
   *
   * The counter gates polling, so a leaked increment stops the overlay refreshing for the life of
   * the controller. `client.write` swallows its own async failures, but URL construction happens
   * before the promise exists and can throw *synchronously* — hence the try/catch around the
   * release rather than relying on the rejection handler alone.
   */
  const submitWrite = (
    requestThreadId: string,
    fallback: AutoResumeState | null,
    body: AutoResumeWrite,
  ) => {
    inFlightWrites.set(requestThreadId, (inFlightWrites.get(requestThreadId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (inFlightWrites.get(requestThreadId) ?? 1) - 1;
      if (remaining <= 0) {
        inFlightWrites.delete(requestThreadId);
      } else {
        inFlightWrites.set(requestThreadId, remaining);
      }
    };

    const applyWriteResult = (next: AutoResumeState | null) => {
      if (disposed || threadId !== requestThreadId) {
        return;
      }
      if (next === null && fallback === null) {
        return;
      }
      state = next ?? fallback;
      emit();
    };

    try {
      void client.write(body).then(
        (next) => {
          release();
          applyWriteResult(next);
        },
        () => release(),
      );
    } catch {
      release();
    }
  };

  /**
   * Sends a debounced resume-message edit immediately.
   *
   * Called on thread change and on dispose. Without it the pending timer is simply dropped: typing
   * in one thread and switching within the debounce window lost the edit silently. Fire-and-forget
   * — it deliberately carries the ORIGINATING threadId and never touches state, since the
   * controller may be going away.
   */
  const flushPendingPrompt = () => {
    if (promptTimer !== null) {
      timers.clearTimeout(promptTimer);
      promptTimer = null;
    }
    const pending = pendingPrompt;
    pendingPrompt = null;
    if (pending === null) {
      return;
    }
    try {
      void client.write({
        threadId: pending.threadId,
        overridePrompt: normalizeOverridePrompt(pending.value),
      });
    } catch {
      // A dropped flush is not worth surfacing; the value is still in the textbox.
    }
  };

  const refresh = () => {
    if (disposed || threadId === null) {
      return;
    }
    const requestThreadId = threadId;
    if ((inFlightWrites.get(requestThreadId) ?? 0) > 0) {
      return;
    }
    const requestToken = loadToken;
    void client.read(requestThreadId).then(
      (next) => {
        if (disposed || requestToken !== loadToken || next === null) {
          return;
        }
        state = next;
        promptDraft = promptDraft ?? next.overridePrompt ?? "";
        emit();
      },
      () => {
        // `read` resolves to null on failure; a rejection here is still non-fatal.
      },
    );
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => snapshot,

    setThread: (nextThreadId) => {
      if (disposed) return;
      flushPendingPrompt();
      loadToken += 1;
      threadId = nextThreadId;
      state = null;
      promptDraft = null;
      emit();
      refresh();
    },

    refresh,

    setEnabled: (enabled) => {
      if (disposed || threadId === null) return;
      const previous = state;
      if (previous === null) {
        return;
      }
      // Optimistic: `submitWrite` puts `previous` back if the write fails.
      state = { ...previous, enabled };
      emit();
      submitWrite(threadId, previous, { threadId, enabled });
    },

    setPromptDraft: (value) => {
      if (disposed || threadId === null) return;
      const requestThreadId = threadId;
      promptDraft = value;
      emit();
      pendingPrompt = { threadId: requestThreadId, value };
      if (promptTimer !== null) {
        timers.clearTimeout(promptTimer);
      }
      promptTimer = timers.setTimeout(() => {
        promptTimer = null;
        pendingPrompt = null;
        submitWrite(requestThreadId, null, {
          threadId: requestThreadId,
          overridePrompt: normalizeOverridePrompt(value),
        });
      }, promptDebounceMs);
    },

    dispose: () => {
      if (disposed) return;
      flushPendingPrompt();
      disposed = true;
      listeners.clear();
    },
  };
}
