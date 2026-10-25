/**
 * The relay is deliberately almost schema-blind: it authenticates, orders and rebroadcasts the
 * manifest verbatim, so manifest changes never need a lockstep relay deploy. The one field it
 * must understand is `buildNumber`, because clients only ever see one payload and cannot order.
 */

/** The smallest shape the relay needs to do its job. Everything else rides along untouched. */
export interface NotificationEnvelope {
  /**
   * Monotonic across releases, sourced from the release workflow's run number. Not the commit
   * hash (`main` is force-pushed, so a released commit may not be an ancestor) and not a
   * timestamp (clock skew between two runners racing to notify).
   */
  readonly buildNumber: number;
}

export type NotificationParseFailure =
  | { readonly kind: "not-json" }
  | { readonly kind: "not-an-object" }
  | { readonly kind: "missing-build-number" }
  | { readonly kind: "invalid-build-number"; readonly value: unknown };

export type NotificationParseResult =
  | { readonly ok: true; readonly envelope: NotificationEnvelope }
  | { readonly ok: false; readonly failure: NotificationParseFailure };

export function describeParseFailure(failure: NotificationParseFailure): string {
  switch (failure.kind) {
    case "not-json":
      return "Body is not valid JSON.";
    case "not-an-object":
      return "Body must be a JSON object.";
    case "missing-build-number":
      return "Body is missing the required `buildNumber` field.";
    case "invalid-build-number":
      return `\`buildNumber\` must be a positive integer, received ${JSON.stringify(failure.value)}.`;
  }
}

export function parseNotification(rawBody: string): NotificationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, failure: { kind: "not-json" } };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: { kind: "not-an-object" } };
  }

  if (!("buildNumber" in parsed)) {
    return { ok: false, failure: { kind: "missing-build-number" } };
  }

  const buildNumber = (parsed as { buildNumber: unknown }).buildNumber;
  if (typeof buildNumber !== "number" || !Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
    return { ok: false, failure: { kind: "invalid-build-number", value: buildNumber } };
  }

  return { ok: true, envelope: { buildNumber } };
}

/**
 * Strictly greater, never equal. Equal is a retry and would wake every app for nothing. Lower is
 * an out-of-order arrival (a slow Windows leg from run N landing after run N+1's macOS leg), and
 * accepting it would silently push every client backwards onto an older build.
 */
export function supersedes(incoming: number, current: number | null): boolean {
  if (current === null) return true;
  return incoming > current;
}
