/**
 * Reading a macOS code signature, and deciding whether it keeps TCC grants. TCC re-evaluates the
 * designated requirement on every access, so an ad-hoc (cdhash-keyed) requirement that changes
 * every build re-prompts every permission. Only a stable certificate identity keeps the grants.
 */

/**
 * The fork's own bundle id: TCC keys rows by bundle id, so sharing upstream's id made the two apps
 * steal each other's grants. Changing it costs users a full round of permission dialogs, and the
 * `.app` name moves with it. Fed through `T3X_DESKTOP_APP_ID`; `mac-signature.test.ts` asserts
 * every build path still sets it, or a sync could silently ship the old id.
 */
export const DESKTOP_BUNDLE_IDENTIFIER = "dev.curlycloud.t3coil";

/** The environment variable the fork's build paths use to set {@link DESKTOP_BUNDLE_IDENTIFIER}. */
export const DESKTOP_APP_ID_ENV_VAR = "T3X_DESKTOP_APP_ID";

/**
 * The fork's self-signed identity (scripts/coil/setup-mac-signing.sh), looked up by name via
 * `CSC_NAME`. Renaming means a new certificate, which voids every TCC grant and the recorded
 * requirement: follow the rotation runbook on the user's Mac BEFORE this lands.
 */
export const MAC_SIGNING_IDENTITY_NAME = "T3 Coil Code Signing";

export interface CodesignDisplay {
  /** `Identifier=` — the SIGNING identifier. Ad-hoc Electron bundles report `Electron` here. */
  readonly identifier: string | undefined;
  /** `Signature=` — `adhoc` when there is no certificate at all. */
  readonly signature: string | undefined;
  /** The `CodeDirectory … flags=0x…(…)` flag names, e.g. `["adhoc", "linker-signed"]`. */
  readonly flags: readonly string[];
  /** Every `Authority=` line, leaf first. Empty for an ad-hoc signature. */
  readonly authorities: readonly string[];
  readonly teamIdentifier: string | undefined;
  /** `Sealed Resources version=…`, or undefined when codesign printed `Sealed Resources=none`. */
  readonly sealedResources: string | undefined;
  /** False when codesign printed `Info.plist=not bound` — the signature does not cover our plist. */
  readonly infoPlistBound: boolean;
}

const FLAGS_PATTERN = /^CodeDirectory\b.*\bflags=0x[0-9a-f]+(?:\(([^)]*)\))?/im;

/**
 * Parse `codesign --display --verbose=4`.
 *
 * Note for anyone calling codesign directly: it writes this report to STDERR, not stdout. Reading
 * only stdout yields an empty string, which parses to "no signature at all" and would report a
 * correctly signed app as broken.
 */
export function parseCodesignDisplay(text: string): CodesignDisplay {
  const field = (name: string): string | undefined => {
    const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
    const value = match?.[1]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };

  const flagsMatch = FLAGS_PATTERN.exec(text);
  const flags = (flagsMatch?.[1] ?? "")
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);

  const authorities = [...text.matchAll(/^Authority=(.*)$/gm)]
    .map((match) => (match[1] ?? "").trim())
    .filter((authority) => authority.length > 0);

  // Sealed is `Sealed Resources version=2 ...` (no `=` after the label), unsealed is
  // `Sealed Resources=none`. Reading it as a plain `Label=value` field would report every
  // correctly signed bundle as sealing nothing.
  const sealedMatch = /^Sealed Resources (version=.*)$/m.exec(text);
  const teamIdentifier = field("TeamIdentifier");

  return {
    identifier: field("Identifier"),
    signature: field("Signature"),
    flags,
    authorities,
    // A self-signed certificate has no team, so codesign prints `not set`. That is expected for
    // the fork's identity, not a defect — hence normalized away rather than reported.
    teamIdentifier: teamIdentifier === "not set" ? undefined : teamIdentifier,
    sealedResources: sealedMatch?.[1],
    // Absence is the signed case: codesign prints this line only to report the NEGATIVE.
    infoPlistBound: !/^Info\.plist=not bound$/m.test(text),
  };
}

/**
 * Pull the requirement out of `codesign --display --requirements -`. Line-based because long
 * requirements wrap, and an ad-hoc clause is printed as a comment (`# designated => cdhash ...`).
 * The clause ends at the next `<name> => ...` line or a bare field line like `Executable=...`.
 */
export function parseDesignatedRequirement(text: string): string | undefined {
  const lines = text.split("\n");
  const startIndex = lines.findIndex((line) => /^\s*(?:#\s*)?designated\s*=>/.test(line));
  if (startIndex === -1) return undefined;

  const parts = [lines[startIndex]!.replace(/^\s*(?:#\s*)?designated\s*=>\s*/, "")];
  for (const line of lines.slice(startIndex + 1)) {
    if (/^\s*(?:#\s*)?[\w.]+\s*=>/.test(line) || /^\S+=/.test(line)) break;
    parts.push(line);
  }

  const normalized = normalizeRequirement(parts.join(" "));
  return normalized.length === 0 ? undefined : normalized;
}

/**
 * Collapse whitespace so a requirement can be compared byte-for-byte against a recorded one.
 *
 * codesign's own line wrapping depends on the length of the identifier and of the certificate
 * hash, neither of which is a semantic difference.
 */
export function normalizeRequirement(requirement: string): string {
  return requirement.replace(/\s+/g, " ").trim();
}

/**
 * Is this requirement keyed to the binary's hash rather than to a certificate? `cdhash H"..."` is
 * codesign's fallback without a certificate, and it changes whenever any byte of the app does, so
 * the grant is voided by the next build.
 */
export function isCdhashKeyedRequirement(requirement: string): boolean {
  return /\bcdhash\s+H"/i.test(requirement);
}

export type MacSignatureVerdictKind = "stable" | "unstable" | "unsigned";

export interface MacSignatureExpectation {
  /** The bundle id the signature must claim. Defaults to the desktop app's. */
  readonly identifier?: string | undefined;
  /**
   * The exact designated requirement previous releases were signed with, normalized. When present,
   * a mismatch is a failure even though the artifact is perfectly signed: a DIFFERENT stable
   * identity still costs the user every permission dialog once.
   */
  readonly requirement?: string | undefined;
  /** The identity name expected in the leaf `Authority=`, when it should be pinned. */
  readonly authority?: string | undefined;
}

export interface MacSignatureVerdict {
  readonly kind: MacSignatureVerdictKind;
  /** Empty when the artifact is signed with the expected stable identity. */
  readonly problems: readonly string[];
  readonly identifier: string | undefined;
  readonly requirement: string | undefined;
  readonly authority: string | undefined;
}

/**
 * Judge a parsed signature against what a TCC-stable release has to look like. `unsigned` (no
 * signing secret) is something a caller may allow; `unstable` (signed, but the requirement moved)
 * is never allowed, because the user sees it exactly as the original bug.
 */
export function evaluateMacSignature(input: {
  readonly display: CodesignDisplay;
  readonly requirement: string | undefined;
  readonly expectation?: MacSignatureExpectation;
}): MacSignatureVerdict {
  const { display, requirement } = input;
  const expectedIdentifier = input.expectation?.identifier ?? DESKTOP_BUNDLE_IDENTIFIER;
  const problems: string[] = [];
  const authority = display.authorities[0];

  const isAdhoc =
    display.signature === "adhoc" ||
    display.flags.includes("adhoc") ||
    display.authorities.length === 0;

  if (isAdhoc) {
    problems.push(
      "the bundle is ad-hoc signed (no certificate), so its designated requirement is a cdhash that changes every build",
    );
  }
  if (requirement === undefined) {
    problems.push("codesign reported no designated requirement");
  } else if (isCdhashKeyedRequirement(requirement)) {
    problems.push(`designated requirement is keyed to a cdhash: ${requirement}`);
  }
  if (display.identifier !== expectedIdentifier) {
    problems.push(
      `signing identifier is ${display.identifier ?? "absent"}, expected ${expectedIdentifier}`,
    );
  }
  if (display.sealedResources === undefined) {
    problems.push("the signature seals no resources (Sealed Resources=none)");
  }
  if (!display.infoPlistBound) {
    problems.push("the signature does not cover Info.plist (Info.plist=not bound)");
  }

  if (isAdhoc) {
    return { kind: "unsigned", problems, identifier: display.identifier, requirement, authority };
  }

  const expectedRequirement = input.expectation?.requirement;
  if (expectedRequirement !== undefined && requirement !== undefined) {
    const expected = normalizeRequirement(expectedRequirement);
    if (expected !== requirement) {
      problems.push(
        `designated requirement changed, so every macOS permission would be re-requested once\n  expected: ${expected}\n  actual:   ${requirement}`,
      );
    }
  }

  const expectedAuthority = input.expectation?.authority;
  if (expectedAuthority !== undefined && authority !== expectedAuthority) {
    problems.push(`leaf authority is ${authority ?? "absent"}, expected ${expectedAuthority}`);
  }

  return {
    kind: problems.length === 0 ? "stable" : "unstable",
    problems,
    identifier: display.identifier,
    requirement,
    authority,
  };
}

/** One-line summary for a build log. */
export function formatMacSignatureVerdict(verdict: MacSignatureVerdict): string {
  const identity = verdict.authority ?? "ad-hoc";
  return [
    `signature: ${verdict.kind}`,
    `identifier: ${verdict.identifier ?? "absent"}`,
    `identity: ${identity}`,
    `designated: ${verdict.requirement ?? "absent"}`,
  ].join("\n  ");
}
