/**
 * Transport + wire parsing for the loop console and the Loops settings panel.
 *
 * Mirrors `coil/autoResumeClient.ts` exactly, for the reasons stated there: the routes are raw
 * (`/api/coil/loop*`), so they are called with `resolvePrimaryEnvironmentHttpUrl` over
 * `primaryEnvironmentHttpLayer` — the only place in the web app that knows how to authenticate the
 * primary environment, and therefore the only call shape that survives remote, relay and tunnel.
 * **Never hardcode an origin here.**
 *
 * Auth is ambient: the environment HTTP layer attaches the credential and the server states the
 * 403. There is deliberately **no client-side scope check** in this file or its callers.
 *
 * The parsers are hand-rolled rather than schema-decoded because the schemas live in
 * `apps/server/src/coil/loop/state.ts`, which the web app cannot import. Every field the server can
 * omit or malform therefore falls back to the same value the server's own decoding default uses,
 * so a partial response degrades to "off" rather than to a crash. `http.test.ts` case 85 is the
 * other half of this contract: it asserts every response decodes against its schema, so a drift
 * shows up on the server side rather than as a silently empty console.
 *
 * @module coil/loop/loopClient
 */

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { primaryEnvironmentHttpLayer } from "~/environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

export const LOOP_PATH = "/api/coil/loop";
export const LOOPS_PATH = "/api/coil/loops";
export const LOOP_SETTINGS_PATH = "/api/coil/loop/settings";
export const LOOP_ANSWER_PATH = "/api/coil/loop/answer";

/** The hard ceiling the arm route enforces. Mirrored here only to word the form's help text. */
export const LOOP_MAX_CHECK_INS = 20;

export type LoopState =
  | "off"
  | "watching"
  | "self_pacing"
  | "standing_down"
  | "held"
  | "blocked"
  | "stopped";

export type LoopStopReason = "done" | "spent" | "stalled" | "handed-back";

export interface LoopBlockerOption {
  readonly label: string;
  readonly description: string;
}

export interface LoopBlocker {
  readonly id: string;
  readonly raisedAtMs: number;
  readonly question: string;
  readonly options: ReadonlyArray<LoopBlockerOption>;
  readonly context: string | null;
  readonly answeredAtMs: number | null;
  readonly answer: string | null;
  /** True once the answer has been restated to the agent in a check-in prompt. */
  readonly deliveredToAgent: boolean;
}

/**
 * A blocking question the runtime raised, as the fork recorded it.
 *
 * This is the only record that survives upstream settling a pending input as an empty answer
 * during session teardown, which is what makes `voided` visible at all.
 */
export interface LoopUserInput {
  readonly requestId: string;
  readonly raisedAtMs: number;
  readonly dialogKind: string | null;
  readonly question: string;
  readonly resolution: "answered" | "voided" | null;
  readonly resolvedAtMs: number | null;
}

export interface LoopCheckInRow {
  readonly n: number;
  readonly firedAtMs: number;
  readonly createdAtIso: string;
  readonly activityCursor: string;
  readonly outcome: "productive" | "unproductive" | "unknown";
}

export interface LoopStopRecord {
  readonly reason: LoopStopReason;
  readonly atMs: number;
  readonly detail: string;
}

export interface LoopRecord {
  readonly armed: boolean;
  readonly armedAtMs: number;
  readonly goal: string | null;
  readonly maxCheckIns: number;
  readonly checkInsUsed: number;
  readonly deadlineAtMs: number;
  readonly idleMs: number;
  readonly busyIdleMs: number;
  readonly degraded: "gate_off" | "wake_lost" | null;
  readonly userInputs: ReadonlyArray<LoopUserInput>;
  readonly checkIns: ReadonlyArray<LoopCheckInRow>;
  readonly strikes: number;
  readonly rateLimitedUntilMs: number;
  readonly stopped: LoopStopRecord | null;
  readonly overridePrompt: string | null;
  readonly blockers: ReadonlyArray<LoopBlocker>;
}

export interface LoopDerived {
  readonly state: LoopState;
  readonly reason: string | null;
  readonly stoppedReason: LoopStopReason | null;
  readonly checkInsUsed: number;
  readonly maxCheckIns: number;
  readonly deadlineAtMs: number;
  readonly msUntilDeadline: number;
  readonly rateLimitedUntilMs: number;
  readonly nextWakeAtMs: number | null;
  readonly snoozedUntilMs: number | null;
  readonly threadKnown: boolean;
  readonly globalEnabled: boolean;
  readonly armedCount: number;
  readonly maxArmedThreads: number;
}

export interface LoopView {
  readonly threadId: string;
  readonly record: LoopRecord;
  readonly derived: LoopDerived;
  /** The *unanswered* blockers — what is actionable now. */
  readonly blockers: ReadonlyArray<LoopBlocker>;
  readonly ledger: ReadonlyArray<LoopCheckInRow>;
}

export interface LoopSettings {
  readonly enabled: boolean;
  readonly maxArmedThreads: number;
  readonly defaultMaxCheckIns: number;
  readonly defaultRunMs: number;
  readonly defaultIdleMs: number;
  readonly defaultBusyIdleMs: number;
  readonly armedCount: number;
}

export interface LoopWriteBody {
  readonly threadId: string;
  /** `clear` forgets a finished run — the reverse of arming, refused while one is armed. */
  readonly action: "arm" | "rearm" | "edit" | "disarm" | "clear";
  readonly maxCheckIns?: number;
  readonly deadlineAtMs?: number;
  readonly goal?: string | null;
  readonly idleMs?: number;
  readonly busyIdleMs?: number;
  readonly overridePrompt?: string | null;
}

export interface LoopAnswerBody {
  readonly threadId: string;
  readonly blockerId: string;
  readonly answer: string;
}

/**
 * A refusal the console must word, kept as the server's own code.
 *
 * The route gives every 400 a distinct code precisely so "you must pick an end time" and "that end
 * time has already passed" are different sentences. Collapsing them into a generic failure here
 * would throw that away, so the code travels to the UI unchanged.
 */
export interface LoopWriteRefused {
  readonly ok: false;
  readonly code: string;
  readonly status: number;
}

export type LoopWriteResult<A> = { readonly ok: true; readonly value: A } | LoopWriteRefused;

export interface LoopClient {
  readonly read: (threadId: string) => Promise<LoopView | null>;
  readonly write: (body: LoopWriteBody) => Promise<LoopWriteResult<LoopView> | null>;
  readonly answer: (body: LoopAnswerBody) => Promise<LoopWriteResult<null> | null>;
  readonly readSettings: () => Promise<LoopSettings | null>;
  readonly writeSettings: (
    patch: Partial<Omit<LoopSettings, "armedCount">>,
  ) => Promise<LoopWriteResult<LoopSettings> | null>;
  readonly listLoops: () => Promise<ReadonlyArray<LoopView> | null>;
}

// --- parsing ----------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const nullableNum = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const nullableStr = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const array = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

const literal = <T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T =>
  typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;

const STOP_REASONS = ["done", "spent", "stalled", "handed-back"] as const;
const LOOP_STATES = [
  "off",
  "watching",
  "self_pacing",
  "standing_down",
  "held",
  "blocked",
  "stopped",
] as const;

function parseBlocker(value: unknown): LoopBlocker | null {
  if (!isJsonObject(value)) return null;
  const id = str(value.id);
  if (id === "") return null;
  return {
    id,
    raisedAtMs: num(value.raisedAtMs, 0),
    question: str(value.question),
    options: array(value.options).flatMap((option) =>
      isJsonObject(option)
        ? [{ label: str(option.label), description: str(option.description) }]
        : [],
    ),
    context: nullableStr(value.context),
    answeredAtMs: nullableNum(value.answeredAtMs),
    answer: nullableStr(value.answer),
    deliveredToAgent: bool(value.deliveredToAgent, false),
  };
}

function parseUserInput(value: unknown): LoopUserInput | null {
  if (!isJsonObject(value)) return null;
  const requestId = str(value.requestId);
  if (requestId === "") return null;
  const resolution = value.resolution;
  return {
    requestId,
    raisedAtMs: num(value.raisedAtMs, 0),
    dialogKind: nullableStr(value.dialogKind),
    question: str(value.question),
    resolution:
      resolution === "answered" || resolution === "voided" ? (resolution as "answered") : null,
    resolvedAtMs: nullableNum(value.resolvedAtMs),
  };
}

function parseCheckInRow(value: unknown): LoopCheckInRow | null {
  if (!isJsonObject(value)) return null;
  return {
    n: num(value.n, 0),
    firedAtMs: num(value.firedAtMs, 0),
    createdAtIso: str(value.createdAtIso),
    activityCursor: str(value.activityCursor),
    outcome: literal(value.outcome, ["productive", "unproductive", "unknown"] as const, "unknown"),
  };
}

function parseStop(value: unknown): LoopStopRecord | null {
  if (!isJsonObject(value)) return null;
  return {
    reason: literal(value.reason, STOP_REASONS, "spent"),
    atMs: num(value.atMs, 0),
    detail: str(value.detail),
  };
}

/** Every fallback here is the server's own fail-closed decoding default. */
export function parseLoopRecord(value: unknown): LoopRecord {
  const raw = isJsonObject(value) ? value : {};
  const degraded = raw.degraded;
  return {
    armed: bool(raw.armed, false),
    armedAtMs: num(raw.armedAtMs, 0),
    goal: nullableStr(raw.goal),
    maxCheckIns: num(raw.maxCheckIns, 0),
    checkInsUsed: num(raw.checkInsUsed, 0),
    deadlineAtMs: num(raw.deadlineAtMs, 0),
    idleMs: num(raw.idleMs, 15 * 60_000),
    busyIdleMs: num(raw.busyIdleMs, 45 * 60_000),
    degraded: degraded === "gate_off" || degraded === "wake_lost" ? degraded : null,
    userInputs: array(raw.userInputs).flatMap((entry) => {
      const parsed = parseUserInput(entry);
      return parsed === null ? [] : [parsed];
    }),
    checkIns: array(raw.checkIns).flatMap((entry) => {
      const parsed = parseCheckInRow(entry);
      return parsed === null ? [] : [parsed];
    }),
    strikes: num(raw.strikes, 0),
    rateLimitedUntilMs: num(raw.rateLimitedUntilMs, 0),
    stopped: parseStop(raw.stopped),
    overridePrompt: nullableStr(raw.overridePrompt),
    blockers: array(raw.blockers).flatMap((entry) => {
      const parsed = parseBlocker(entry);
      return parsed === null ? [] : [parsed];
    }),
  };
}

export function parseLoopView(value: unknown): LoopView | null {
  if (!isJsonObject(value)) return null;
  const threadId = str(value.threadId);
  if (threadId === "") return null;
  const record = parseLoopRecord(value.record);
  const rawDerived = isJsonObject(value.derived) ? value.derived : {};
  const derived: LoopDerived = {
    state: literal(rawDerived.state, LOOP_STATES, record.stopped === null ? "off" : "stopped"),
    reason: nullableStr(rawDerived.reason),
    stoppedReason:
      typeof rawDerived.stoppedReason === "string"
        ? literal(rawDerived.stoppedReason, STOP_REASONS, "spent")
        : null,
    checkInsUsed: num(rawDerived.checkInsUsed, record.checkInsUsed),
    maxCheckIns: num(rawDerived.maxCheckIns, record.maxCheckIns),
    deadlineAtMs: num(rawDerived.deadlineAtMs, record.deadlineAtMs),
    msUntilDeadline: num(rawDerived.msUntilDeadline, 0),
    rateLimitedUntilMs: num(rawDerived.rateLimitedUntilMs, record.rateLimitedUntilMs),
    nextWakeAtMs: nullableNum(rawDerived.nextWakeAtMs),
    snoozedUntilMs: nullableNum(rawDerived.snoozedUntilMs),
    threadKnown: bool(rawDerived.threadKnown, false),
    globalEnabled: bool(rawDerived.globalEnabled, false),
    armedCount: num(rawDerived.armedCount, 0),
    maxArmedThreads: num(rawDerived.maxArmedThreads, 0),
  };
  return {
    threadId,
    record,
    derived,
    blockers: array(value.blockers).flatMap((entry) => {
      const parsed = parseBlocker(entry);
      return parsed === null ? [] : [parsed];
    }),
    ledger: array(value.ledger).flatMap((entry) => {
      const parsed = parseCheckInRow(entry);
      return parsed === null ? [] : [parsed];
    }),
  };
}

export function parseLoopSettings(value: unknown): LoopSettings | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  return {
    enabled: value.enabled,
    maxArmedThreads: num(value.maxArmedThreads, 3),
    defaultMaxCheckIns: num(value.defaultMaxCheckIns, 6),
    defaultRunMs: num(value.defaultRunMs, 8 * 3_600_000),
    defaultIdleMs: num(value.defaultIdleMs, 15 * 60_000),
    defaultBusyIdleMs: num(value.defaultBusyIdleMs, 45 * 60_000),
    armedCount: num(value.armedCount, 0),
  };
}

/** The error code out of a 400 body, or a stand-in so a refusal is never silently blank. */
function parseRefusal(status: number, body: unknown): LoopWriteRefused {
  const code = isJsonObject(body) ? str(body.error, "") : "";
  return { ok: false, status, code: code === "" ? `http_${status}` : code };
}

// --- transport --------------------------------------------------------------

const loopRuntime = ManagedRuntime.make(primaryEnvironmentHttpLayer);

/**
 * Runs a request, swallowing **every** failure to `null`.
 *
 * The console is layered over the thread view, so a 401, an undeployed route or an offline client
 * must make it disappear rather than degrade chat. `null` means "we do not know"; it is never
 * rendered as "there is no loop".
 */
async function run<A, E>(
  effect: Effect.Effect<A | null, E, HttpClient.HttpClient>,
): Promise<A | null> {
  try {
    return await loopRuntime.runPromise(effect);
  } catch {
    return null;
  }
}

const postJson = <A>(url: string, body: unknown, parse: (value: unknown) => A | null) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
    );
    if (response.status !== 200) {
      return parseRefusal(response.status, yield* Effect.orElseSucceed(response.json, () => null));
    }
    const value = parse(yield* response.json);
    return value === null ? null : ({ ok: true, value } as const);
  });

export const httpLoopClient: LoopClient = {
  read: (threadId) =>
    run(
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          resolvePrimaryEnvironmentHttpUrl(LOOP_PATH, { threadId }),
        );
        if (response.status !== 200) return null;
        return parseLoopView(yield* response.json);
      }),
    ),

  write: (body) => run(postJson(resolvePrimaryEnvironmentHttpUrl(LOOP_PATH), body, parseLoopView)),

  answer: (body) =>
    run(
      postJson(resolvePrimaryEnvironmentHttpUrl(LOOP_ANSWER_PATH), body, (value) =>
        isJsonObject(value) && value.ok === true ? null : null,
      ).pipe(
        // The route's success body is `{ ok: true }` and carries nothing the console needs, so a
        // 200 resolves to `{ ok: true, value: null }` and the caller re-reads the view.
        Effect.map((result) =>
          result === null || result.ok === false ? result : { ok: true as const, value: null },
        ),
      ),
    ),

  readSettings: () =>
    run(
      Effect.gen(function* () {
        const response = yield* HttpClient.get(
          resolvePrimaryEnvironmentHttpUrl(LOOP_SETTINGS_PATH),
        );
        if (response.status !== 200) return null;
        return parseLoopSettings(yield* response.json);
      }),
    ),

  writeSettings: (patch) =>
    run(postJson(resolvePrimaryEnvironmentHttpUrl(LOOP_SETTINGS_PATH), patch, parseLoopSettings)),

  listLoops: () =>
    run(
      Effect.gen(function* () {
        const response = yield* HttpClient.get(resolvePrimaryEnvironmentHttpUrl(LOOPS_PATH));
        if (response.status !== 200) return null;
        const body = yield* response.json;
        if (!isJsonObject(body)) return null;
        return array(body.loops).flatMap((entry) => {
          const parsed = parseLoopView(entry);
          return parsed === null ? [] : [parsed];
        });
      }),
    ),
};
