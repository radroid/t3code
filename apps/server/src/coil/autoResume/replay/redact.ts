/**
 * Redaction for committed replay fixtures.
 *
 * Provider logs hold real conversations, file paths and tool output. Fixtures built from
 * them are committed to a public fork, so the recorder must strip content before anything
 * lands in git.
 *
 * The policy is an **allowlist**, and the direction matters: a denylist ("drop `text`,
 * drop `cwd`") silently leaks the next field the SDK adds, and this file's whole job is to
 * be safe against a vendor schema we do not control. So: every string is redacted unless
 * something explicitly justifies keeping it.
 *
 * A string survives when it is
 *   1. under a structural key (`type`, `status`, `rateLimitType`, `exitKind`, …), or
 *   2. shaped like an identifier or timestamp (uuid / ISO-8601), whatever its key, or
 *   3. inside a subtree marked keep-verbatim (`rate_limit_info` — pure telemetry), or
 *   4. vendor-authored limit text (see `isVendorAuthoredText`).
 *
 * Numbers, booleans and nulls are always kept: they carry the structure auto-resume reads
 * (`resetsAt`, `is_error`, `num_turns`, `isUsingOverage`) and cannot carry prose.
 *
 * Object *keys* are preserved (their values are not), because keys are the SDK's schema
 * and dropping them would leave a fixture that no longer decodes. The residual exposure is
 * a user-defined MCP tool whose argument names are themselves sensitive; values are still
 * redacted, so this is judged acceptable. Revisit if fixtures ever capture such a tool.
 *
 * Rule 4 is the subtle one. In the #118 episode the load-bearing string is the vendor's
 * own "You've hit your individual spend limit · run /usage-credits…", carried by a
 * synthetic assistant message (`model:"<synthetic>"`) and by `result.result` when
 * `is_error` is true. Redacting those would destroy exactly the evidence the fixture
 * exists to preserve, and they contain no user content — they are strings the provider
 * generated, identical for every account.
 *
 * @module coil/autoResume/replay/redact
 */

export const REDACTED = "«redacted»";
export const REDACTION_POLICY = "allowlist-v1";

/**
 * Keys whose string values are structure, not content: message/event discriminators,
 * status enums, and the identifiers that make a replay reproduce the original session.
 * Identifiers are random uuids with no user content, and the adapter's behaviour depends
 * on them (`session_id` drives resume-cursor bookkeeping), so they are kept.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  // discriminators + status
  "type",
  "subtype",
  "status",
  "kind",
  "role",
  "model",
  "provider",
  "method",
  "source",
  "messageType",
  "stop_reason",
  "stop_sequence",
  "permissionMode",
  "apiKeySource",
  "exitKind",
  "reason",
  "name",
  // rate-limit telemetry
  "rateLimitType",
  "overageStatus",
  "overageDisabledReason",
  // identifiers
  "id",
  "uuid",
  "eventId",
  "itemId",
  "threadId",
  "turnId",
  "commandId",
  "messageId",
  "requestId",
  "session_id",
  "providerThreadId",
  "providerInstanceId",
  "parent_tool_use_id",
  "tool_use_id",
  // timestamps
  "createdAt",
  "observedAt",
  "updatedAt",
  "startedAt",
  "completedAt",
]);

/** Subtrees kept verbatim: pure provider telemetry that cannot contain user content. */
const KEEP_VERBATIM_KEYS: ReadonlySet<string> = new Set(["rate_limit_info", "usage"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Vendor-authored strings worth keeping: the provider's own limit messaging, which is
 * account-independent and is the very signal these fixtures capture. Matched narrowly —
 * anything not recognised is redacted.
 */
const VENDOR_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  // Observed verbatim: "You've hit your session limit · resets 1:50pm (America/Toronto)"
  // and "You've hit your individual spend limit · run /usage-credits…".
  /you'?ve hit your [\w\s]{0,30}limit/i,
  /usage limit reached/i,
  /\/usage-credits\b/i,
  /upgrade to increase your usage limit/i,
];

// Deliberately NOT a pattern: a bare /rate limit/. It matched this repo's own prose about
// the rate-limit feature, which is precisely the content redaction exists to drop — a
// capture taken during work on auto-resume would have kept whole paragraphs of it. Vendor
// patterns must match the vendor's sentence, not its subject matter.

export function isVendorAuthoredText(value: string): boolean {
  return VENDOR_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export interface RedactionReport {
  /** Strings replaced with the placeholder. */
  readonly redactedStrings: number;
  /** Strings kept because they matched a vendor-text pattern (rule 4). */
  readonly keptVendorStrings: number;
}

interface Counters {
  redacted: number;
  keptVendor: number;
}

function keepString(key: string | null, value: string, counters: Counters): string {
  if (key !== null && STRUCTURAL_KEYS.has(key)) return value;
  if (UUID_PATTERN.test(value) || ISO_PATTERN.test(value)) return value;
  if (isVendorAuthoredText(value)) {
    counters.keptVendor += 1;
    return value;
  }
  // Empty strings carry no content and their absence changes decode behaviour.
  if (value.length === 0) return value;
  counters.redacted += 1;
  return REDACTED;
}

function walk(value: unknown, key: string | null, verbatim: boolean, counters: Counters): unknown {
  if (verbatim) return value;
  if (typeof value === "string") return keepString(key, value, counters);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    // Array elements inherit their parent's key: `content[]` blocks are judged as `content`.
    return value.map((entry) => walk(entry, key, verbatim, counters));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = walk(childValue, childKey, KEEP_VERBATIM_KEYS.has(childKey), counters);
    }
    return out;
  }
  // undefined / function / symbol: not representable in a JSON fixture.
  return undefined;
}

/** Redact a parsed JSON value for committing. Returns the copy and what it changed. */
export function redact(value: unknown): {
  readonly value: unknown;
  readonly report: RedactionReport;
} {
  const counters: Counters = { redacted: 0, keptVendor: 0 };
  const redacted = walk(value, null, false, counters);
  return {
    value: redacted,
    report: { redactedStrings: counters.redacted, keptVendorStrings: counters.keptVendor },
  };
}

/** Merge per-message reports into one fixture-level total. */
export function mergeReports(reports: ReadonlyArray<RedactionReport>): RedactionReport {
  return reports.reduce<RedactionReport>(
    (acc, report) => ({
      redactedStrings: acc.redactedStrings + report.redactedStrings,
      keptVendorStrings: acc.keptVendorStrings + report.keptVendorStrings,
    }),
    { redactedStrings: 0, keptVendorStrings: 0 },
  );
}
