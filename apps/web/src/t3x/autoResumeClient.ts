/**
 * Transport + wire parsing for the per-thread auto-resume control.
 *
 * Split out of `AutoResumeOverlay.tsx` so the overlay's lifecycle logic can be tested against a
 * fake client (see `autoResumeController.ts`). The parsers are exported for the same reason: the
 * server route is fork-owned but its responses still cross a JSON boundary, and every field it
 * can omit or malform has a test.
 *
 * @module t3x/autoResumeClient
 */

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { primaryEnvironmentHttpLayer } from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

export const AUTO_RESUME_PATH = "/api/t3x/auto-resume";

export interface AutoResumeThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface AutoResumePending {
  readonly resumeAtMs: number;
  readonly reason: string;
}

export interface AutoResumeState {
  readonly enabled: boolean;
  readonly overridePrompt: string | null;
  readonly pending: AutoResumePending | null;
}

export interface AutoResumeWrite {
  readonly threadId: string;
  readonly enabled?: boolean;
  readonly overridePrompt?: string | null;
}

/**
 * The seam the controller talks to. Both methods resolve to `null` on *any* failure rather than
 * rejecting — auto-resume is an enhancement layered over the thread view, so a 401, an undeployed
 * route, or an offline client must make the overlay disappear, never degrade the chat.
 */
export interface AutoResumeClient {
  readonly read: (threadId: string) => Promise<AutoResumeState | null>;
  readonly write: (body: AutoResumeWrite) => Promise<AutoResumeState | null>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAutoResumePending(value: unknown): AutoResumePending | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const { resumeAtMs, reason } = value;
  if (typeof resumeAtMs !== "number" || !Number.isFinite(resumeAtMs)) {
    return null;
  }
  return { resumeAtMs, reason: typeof reason === "string" ? reason : "" };
}

export function parseAutoResumeState(value: unknown): AutoResumeState | null {
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
 * `/api/t3x/auto-resume` is a raw route, so it has to be called the same way
 * `observability/clientTracing.ts` calls `/api/observability/v1/traces`: build the URL with
 * `resolvePrimaryEnvironmentHttpUrl` and run over `primaryEnvironmentHttpLayer`, which is the only
 * place in the web app that knows how to authenticate the primary environment (session cookies for
 * a same-origin browser primary, desktop bearer token otherwise).
 */
const autoResumeRuntime = ManagedRuntime.make(primaryEnvironmentHttpLayer);

async function runAutoResumeRequest<E>(
  effect: Effect.Effect<AutoResumeState | null, E, HttpClient.HttpClient>,
): Promise<AutoResumeState | null> {
  try {
    return await autoResumeRuntime.runPromise(effect);
  } catch {
    return null;
  }
}

export const httpAutoResumeClient: AutoResumeClient = {
  read: (threadId) => {
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
  },
  write: (body) => {
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
  },
};
