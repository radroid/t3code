/**
 * Reading a macOS code signature, and deciding whether it is the kind that keeps TCC grants.
 *
 * Issue #70: the fork's desktop builds were ad-hoc signed, so `codesign` derived each bundle's
 * DESIGNATED REQUIREMENT from the binary's cdhash. TCC (the permissions database) stores that
 * requirement alongside the grant and re-evaluates it on every access, so a requirement that
 * changes on every build makes every update look like a brand-new app — and re-asks for Screen
 * Recording, Accessibility, Microphone, Files & Folders and Local Network from scratch.
 *
 * The fix is not "sign the app" but "sign it with a stable identity". Those are different claims,
 * and only the second one keeps the grants:
 *
 *   ad-hoc      designated => cdhash H"d48d810e…"                      <- new every build
 *   certificate designated => identifier "com.t3tools.t3code" and …    <- same every build
 *
 * So the check this file exists to express is about the SHAPE of the requirement, not the presence
 * of a signature. Everything here is pure: the codesign output is parsed, never produced, which is
 * what makes the decision testable without a 470 MB build.
 */

/**
 * The fork's own bundle id, and the second half of the #70 fix.
 *
 * macOS stores one TCC row per `(service, client)`, where `client` is the bundle id — so the fork's
 * build and upstream's `T3 Code (Nightly)`, both `com.t3tools.t3code` and both commonly installed,
 * shared one row per permission. Whichever launched last owned the grant and the other was
 * re-prompted, which no amount of correct signing can fix. Renamed after `coil`
 * (coil.curlycloud.dev), the fork's own home.
 *
 * Deliberately NOT a rename of `productName`: the updater refuses an install when the `.app` name
 * inside the dmg differs from the installed one (`resolveMacInstallTarget`), so renaming the app
 * would break the very update path this is meant to make quiet. The app stays `T3 Code (Alpha)`.
 *
 * Fed to the build through `T3X_DESKTOP_APP_ID`, which `scripts/build-desktop-artifact.ts` reads.
 * `mac-signature.test.ts` asserts that hook still exists and that every build path sets it to this
 * value — an upstream sync that reverts the seam, or a workflow that forgets the variable, would
 * otherwise silently ship the old id and reset every permission again.
 */
export const DESKTOP_BUNDLE_IDENTIFIER = "dev.curlycloud.coil";

/** The environment variable the fork's build paths use to set {@link DESKTOP_BUNDLE_IDENTIFIER}. */
export const DESKTOP_APP_ID_ENV_VAR = "T3X_DESKTOP_APP_ID";

/**
 * The fork's self-signed code-signing identity, created by scripts/coil/setup-mac-signing.sh.
 *
 * A plain name, not a hash: `codesign` and electron-builder both look identities up by name
 * (`CSC_NAME`), and the name is what has to match between this Mac's login keychain and the
 * ephemeral keychain the release workflow builds from the p12 secret.
 */
export const MAC_SIGNING_IDENTITY_NAME = "T3X Code Signing";

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

  // Two shapes, and only one of them has an `=` after the label:
  //   Sealed Resources=none                              (nothing sealed)
  //   Sealed Resources version=2 rules=13 files=1234     (sealed)
  // Reading it as a plain `Label=value` field matches only the first, which reports every
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
 * Pull the requirement out of `codesign --display --requirements -`.
 *
 * Line-based rather than one regex, for two reasons the real output forces:
 *
 * - A long requirement WRAPS, so the clause continues on following lines and has to be re-joined.
 * - An ad-hoc bundle's clause is emitted as a COMMENT — `# designated => cdhash H"…"` — which is
 *   the single most important case to recognise, so the leading `#` cannot be part of the anchor.
 *
 * The clause ends at the next `<name> => …` line (codesign prints several) or at a bare field line
 * such as `Executable=…`, whichever comes first.
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
 * Is this requirement keyed to the binary's hash rather than to a certificate?
 *
 * `cdhash H"…"` is what codesign falls back to when there is no certificate to name. It is the
 * whole bug: the hash changes whenever a single byte of the app changes, so the grant is voided by
 * the next build. An ad-hoc bundle's requirement is the bare form; a signed bundle's requirement
 * names an identifier and a certificate.
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
 * Judge a parsed signature against what a TCC-stable release has to look like.
 *
 * `unsigned` and `unstable` are kept apart deliberately. Unsigned is the state the fork shipped in
 * before #70 and is what a build with no signing secret still produces — a caller may allow it.
 * Unstable means the artifact IS signed but the requirement moved, which no caller should allow,
 * because it is indistinguishable from the bug at the point where the user notices it.
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
