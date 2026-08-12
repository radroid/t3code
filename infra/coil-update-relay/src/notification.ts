/**
 * The relay is deliberately almost schema-blind.
 *
 * It authenticates the sender, orders payloads, and rebroadcasts them verbatim. It does *not*
 * understand the manifest — asset URLs, checksums, platform keys and commit hashes are opaque
 * passthrough. The desktop client owns that schema.
 *
 * That is not laziness. If the relay parsed the manifest, every manifest change would need a
 * relay deploy in lockstep with an app release, and a relay running older code would start
 * rejecting valid payloads. The one field it must understand is `buildNumber`, because ordering
 * cannot be delegated to a client that only ever sees one payload at a time.
 */

/** The smallest shape the relay needs to do its job. Everything else rides along untouched. */
export interface NotificationEnvelope {
  /**
   * Monotonic across releases. Sourced from the release workflow's run number.
   *
   * Not the commit hash, and not a timestamp. The hash cannot answer "is this newer" at all, and
   * on this fork it especially cannot: `main` is force-pushed by the sync playbook, so a released
   * commit may not even be an ancestor of `main`. Timestamps lose to clock skew between two
   * runners racing to notify.
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
  if (
    typeof buildNumber !== "number" ||
    !Number.isSafeInteger(buildNumber) ||
    buildNumber <= 0
  ) {
    return { ok: false, failure: { kind: "invalid-build-number", value: buildNumber } };
  }

  return { ok: true, envelope: { buildNumber } };
}

/**
 * Strictly greater, never equal.
 *
 * Equal means a retry of a notify we already accepted — re-broadcasting it would wake every
 * connected app for nothing. Lower means an out-of-order arrival, which is the case that
 * actually matters: the release matrix has two legs, and a slow Windows leg from run N can land
 * after run N+1's macOS leg. Accepting it would push every client *backwards* onto an older
 * build, which looks exactly like a successful update and is the hardest failure here to notice.
 */
export function supersedes(incoming: number, current: number | null): boolean {
  if (current === null) return true;
  return incoming > current;
}
