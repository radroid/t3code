/**
 * Sender authentication for `POST /notify`.
 *
 * The *payload* is public — this fork is a public repo, so "main moved to <sha>" is already
 * visible to anyone. Nothing here protects confidentiality. What it protects is the ability to
 * make every installed app restart into an attacker-chosen artifact, which is why the write path
 * is authenticated and the read paths are not.
 */

const SIGNATURE_PREFIX = "sha256=";

/** Generous enough for a ~470 MB upload to finish, tight enough to bound replay. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type SignatureFailure =
  | { readonly kind: "missing-signature" }
  | { readonly kind: "missing-timestamp" }
  | { readonly kind: "malformed-signature" }
  | { readonly kind: "malformed-timestamp"; readonly value: string }
  | { readonly kind: "timestamp-skew"; readonly skewSeconds: number }
  | { readonly kind: "mismatch" };

export function describeSignatureFailure(failure: SignatureFailure): string {
  switch (failure.kind) {
    case "missing-signature":
      return "Missing X-Coil-Signature header.";
    case "missing-timestamp":
      return "Missing X-Coil-Timestamp header.";
    case "malformed-signature":
      return "X-Coil-Signature must be of the form sha256=<hex>.";
    case "malformed-timestamp":
      return `X-Coil-Timestamp must be integer epoch seconds, received "${failure.value}".`;
    case "timestamp-skew":
      return `X-Coil-Timestamp is ${failure.skewSeconds}s away from now, which exceeds the ${MAX_TIMESTAMP_SKEW_SECONDS}s window.`;
    case "mismatch":
      return "Signature does not match.";
  }
}

/**
 * The signed material is `<timestamp>.<body>`.
 *
 * The timestamp is a separate header rather than a field inside the manifest, because the
 * manifest's own `builtAt` is *build* time. Uploading the artifacts routinely takes minutes, so a
 * skew window anchored on `builtAt` would either reject every real notify or be so wide it stops
 * bounding anything. Binding the timestamp into the signature is also what stops it being
 * rewritten in transit to refresh a captured request.
 */
export function signingMaterial(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function parseTimestamp(
  header: string | null,
  nowSeconds: number,
):
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly failure: SignatureFailure } {
  if (header === null || header.trim() === "") {
    return { ok: false, failure: { kind: "missing-timestamp" } };
  }

  const timestamp = Number(header.trim());
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, failure: { kind: "malformed-timestamp", value: header } };
  }

  // Absolute, so a timestamp from the future is rejected too — otherwise a captured request could
  // be held and replayed indefinitely just by having been signed with a far-future clock.
  const skewSeconds = Math.abs(nowSeconds - timestamp);
  if (skewSeconds > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, failure: { kind: "timestamp-skew", skewSeconds } };
  }

  return { ok: true, timestamp };
}

function decodeHexSignature(header: string): Uint8Array | null {
  if (!header.startsWith(SIGNATURE_PREFIX)) return null;
  const hex = header.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function encodeHexSignature(bytes: ArrayBuffer): string {
  return (
    SIGNATURE_PREFIX +
    Array.from(new Uint8Array(bytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

/** Length-independent constant-time compare. Returns false for mismatched lengths without leaking where. */
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function verifySignature(args: {
  readonly secret: string;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
  readonly rawBody: string;
  readonly nowSeconds: number;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly failure: SignatureFailure }> {
  if (args.signatureHeader === null || args.signatureHeader.trim() === "") {
    return { ok: false, failure: { kind: "missing-signature" } };
  }

  const timestamp = parseTimestamp(args.timestampHeader, args.nowSeconds);
  if (!timestamp.ok) return timestamp;

  const provided = decodeHexSignature(args.signatureHeader.trim());
  if (provided === null) {
    return { ok: false, failure: { kind: "malformed-signature" } };
  }

  const expected = new Uint8Array(
    await hmacSha256(args.secret, signingMaterial(String(timestamp.timestamp), args.rawBody)),
  );

  return timingSafeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, failure: { kind: "mismatch" } };
}

export async function createSignature(args: {
  readonly secret: string;
  readonly timestamp: number;
  readonly rawBody: string;
}): Promise<string> {
  return encodeHexSignature(
    await hmacSha256(args.secret, signingMaterial(String(args.timestamp), args.rawBody)),
  );
}
