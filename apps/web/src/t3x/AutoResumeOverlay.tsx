import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { primaryEnvironmentHttpLayer } from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";
import { cn } from "~/lib/utils";

const AUTO_RESUME_PATH = "/api/t3x/auto-resume";
const POLL_INTERVAL_MS = 30_000;
const PROMPT_DEBOUNCE_MS = 600;

export interface AutoResumeThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

interface AutoResumePending {
  readonly resumeAtMs: number;
  readonly reason: string;
}

interface AutoResumeState {
  readonly enabled: boolean;
  readonly overridePrompt: string | null;
  readonly pending: AutoResumePending | null;
}

interface AutoResumeWrite {
  readonly threadId: string;
  readonly enabled?: boolean;
  readonly overridePrompt?: string | null;
}

/**
 * `/api/t3x/auto-resume` is a raw route, so it has to be called the same way
 * `observability/clientTracing.ts` calls `/api/observability/v1/traces`: build the URL with
 * `resolvePrimaryEnvironmentHttpUrl` and run over `primaryEnvironmentHttpLayer`, which is the only
 * place in the web app that knows how to authenticate the primary environment (session cookies for
 * a same-origin browser primary, desktop bearer token otherwise).
 */
const autoResumeRuntime = ManagedRuntime.make(primaryEnvironmentHttpLayer);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAutoResumePending(value: unknown): AutoResumePending | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const { resumeAtMs, reason } = value;
  if (typeof resumeAtMs !== "number" || !Number.isFinite(resumeAtMs)) {
    return null;
  }
  return { resumeAtMs, reason: typeof reason === "string" ? reason : "" };
}

function parseAutoResumeState(value: unknown): AutoResumeState | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const { enabled, overridePrompt, pending } = value;
  if (typeof enabled !== "boolean") {
    return null;
  }
  return {
    enabled,
    overridePrompt:
      typeof overridePrompt === "string" && overridePrompt !== "" ? overridePrompt : null,
    pending: parseAutoResumePending(pending),
  };
}

/**
 * Auto-resume is an enhancement layered over the thread view: any failure (401, route not deployed,
 * offline) resolves to `null` so the overlay simply disappears instead of degrading the chat.
 */
async function runAutoResumeRequest<E>(
  effect: Effect.Effect<AutoResumeState | null, E, HttpClient.HttpClient>,
): Promise<AutoResumeState | null> {
  try {
    return await autoResumeRuntime.runPromise(effect);
  } catch {
    return null;
  }
}

function readAutoResumeState(threadId: string): Promise<AutoResumeState | null> {
  const url = resolvePrimaryEnvironmentHttpUrl(AUTO_RESUME_PATH, { threadId });
  return runAutoResumeRequest(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(url);
      if (response.status !== 200) {
        return null;
      }
      return parseAutoResumeState(yield* response.json);
    }),
  );
}

function writeAutoResumeState(body: AutoResumeWrite): Promise<AutoResumeState | null> {
  const url = resolvePrimaryEnvironmentHttpUrl(AUTO_RESUME_PATH);
  return runAutoResumeRequest(
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(
        HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
      );
      if (response.status !== 200) {
        return null;
      }
      return parseAutoResumeState(yield* response.json);
    }),
  );
}

const nextAttemptFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

function formatNextAttempt(resumeAtMs: number): string {
  return nextAttemptFormatter.format(new Date(resumeAtMs));
}

export function formatAutoResumeStatus(state: AutoResumeState): string {
  if (!state.enabled) {
    return "Auto-resume: off";
  }
  if (state.pending === null) {
    return "Auto-resume: on";
  }
  return `Auto-resume: on · next attempt ~${formatNextAttempt(state.pending.resumeAtMs)}`;
}

function normalizeOverridePrompt(value: string): string | null {
  return value.trim() === "" ? null : value;
}

interface AutoResumeOverlayProps {
  readonly threadRef: AutoResumeThreadRef;
}

/**
 * Floating per-thread control for auto-resume (auto-continuing a thread after a usage-limit pause).
 * Renders nothing until the server confirms the feature is reachable for this thread.
 */
export function AutoResumeOverlay({ threadRef }: AutoResumeOverlayProps) {
  const threadId = threadRef.threadId;
  const switchId = useId();
  const [state, setState] = useState<AutoResumeState | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const mountedRef = useRef(true);
  const threadIdRef = useRef(threadId);
  const inFlightWritesRef = useRef(0);
  const promptTimerRef = useRef<number | null>(null);
  // The edit a debounced write is waiting to send, so it can be flushed rather than
  // dropped when the thread changes mid-debounce.
  const pendingPromptRef = useRef<{ threadId: string; value: string } | null>(null);

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (promptTimerRef.current !== null) {
        window.clearTimeout(promptTimerRef.current);
        promptTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setPromptDraft(null);
    setExpanded(false);

    const load = async () => {
      // Never let a poll response stomp an optimistic value that has not round-tripped yet.
      if (inFlightWritesRef.current > 0) {
        return;
      }
      const next = await readAutoResumeState(threadId);
      if (cancelled || next === null) {
        return;
      }
      setState(next);
      setPromptDraft((current) => current ?? next.overridePrompt ?? "");
    };

    void load();
    const intervalId = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    const handleFocus = () => void load();
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [threadId]);

  const applyWriteResult = useCallback(
    (requestThreadId: string, fallback: AutoResumeState | null, next: AutoResumeState | null) => {
      if (!mountedRef.current || threadIdRef.current !== requestThreadId) {
        return;
      }
      if (next === null && fallback === null) {
        return;
      }
      setState(next ?? fallback);
    },
    [],
  );

  /**
   * Issues a write and guarantees the in-flight counter is released exactly once.
   *
   * The counter gates polling, so a leaked increment stops the overlay refreshing for the
   * life of the component. `writeAutoResumeState` swallows its own async failures, but URL
   * construction happens before the promise exists and can throw synchronously — hence the
   * try/catch around the release rather than relying on `.then` alone.
   */
  const submitWrite = useCallback(
    (requestThreadId: string, fallback: AutoResumeState | null, body: AutoResumeWrite) => {
      inFlightWritesRef.current += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlightWritesRef.current -= 1;
      };
      try {
        void writeAutoResumeState(body).then(
          (next) => {
            release();
            applyWriteResult(requestThreadId, fallback, next);
          },
          () => release(),
        );
      } catch {
        release();
      }
    },
    [applyWriteResult],
  );

  /**
   * Sends a debounced resume-message edit immediately.
   *
   * Called when the thread changes or the overlay unmounts. Without it the pending timer
   * is simply dropped: typing in one thread and switching within the debounce window lost
   * the edit silently, because the next keystroke in the new thread cleared the old timer.
   * Fire-and-forget — it deliberately carries the ORIGINATING threadId and never touches
   * state, since the component may be unmounting.
   */
  const flushPendingPrompt = useCallback(() => {
    if (promptTimerRef.current !== null) {
      window.clearTimeout(promptTimerRef.current);
      promptTimerRef.current = null;
    }
    const pending = pendingPromptRef.current;
    pendingPromptRef.current = null;
    if (pending === null) {
      return;
    }
    try {
      void writeAutoResumeState({
        threadId: pending.threadId,
        overridePrompt: normalizeOverridePrompt(pending.value),
      });
    } catch {
      // A dropped flush is not worth surfacing; the value is still in the textbox.
    }
  }, []);

  // Flush on thread change AND on unmount (this cleanup runs for both).
  useEffect(() => () => flushPendingPrompt(), [threadId, flushPendingPrompt]);

  const handleToggle = useCallback(
    (checked: boolean) => {
      const previous = state;
      if (previous === null) {
        return;
      }
      // Optimistic: `applyWriteResult` puts `previous` back if the write fails.
      setState({ ...previous, enabled: checked });
      submitWrite(threadId, previous, { threadId, enabled: checked });
    },
    [state, submitWrite, threadId],
  );

  const handlePromptChange = useCallback(
    (value: string) => {
      setPromptDraft(value);
      pendingPromptRef.current = { threadId, value };
      if (promptTimerRef.current !== null) {
        window.clearTimeout(promptTimerRef.current);
      }
      promptTimerRef.current = window.setTimeout(() => {
        promptTimerRef.current = null;
        pendingPromptRef.current = null;
        submitWrite(threadId, null, {
          threadId,
          overridePrompt: normalizeOverridePrompt(value),
        });
      }, PROMPT_DEBOUNCE_MS);
    },
    [submitWrite, threadId],
  );

  if (state === null) {
    return null;
  }

  const pending = state.pending;

  return (
    <div className="pointer-events-none absolute top-[calc(var(--workspace-topbar-height)+0.5rem)] right-3 z-30 flex max-w-[min(18rem,calc(100%-1.5rem))] flex-col items-end gap-1.5">
      <button
        aria-expanded={expanded}
        className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:cursor-pointer hover:border-border hover:text-foreground"
        onClick={() => setExpanded((open) => !open)}
        type="button"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state.enabled ? "bg-primary" : "bg-muted-foreground/40",
          )}
        />
        <span className="truncate">{formatAutoResumeStatus(state)}</span>
        {expanded ? (
          <ChevronUpIcon className="size-3 shrink-0" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0" />
        )}
      </button>

      {expanded ? (
        <div className="pointer-events-auto w-72 max-w-full rounded-lg border border-border/60 bg-card p-3 shadow-md">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs" htmlFor={switchId}>
              Resume after usage limits
            </Label>
            <Switch checked={state.enabled} id={switchId} onCheckedChange={handleToggle} />
          </div>

          {pending !== null ? (
            <p className="mt-2 text-muted-foreground text-xs">
              {pending.reason === "" ? "Paused" : `Paused: ${pending.reason}`} · next attempt ~
              {formatNextAttempt(pending.resumeAtMs)}
            </p>
          ) : null}

          <Textarea
            aria-label="Auto-resume message"
            className="mt-2"
            onChange={(event) => handlePromptChange(event.target.value)}
            placeholder="continue"
            size="sm"
            value={promptDraft ?? ""}
          />
          <p className="mt-1.5 text-muted-foreground text-xs">
            Message sent when the thread resumes.
          </p>
        </div>
      ) : null}
    </div>
  );
}
