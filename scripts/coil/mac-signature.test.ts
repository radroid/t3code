import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DESKTOP_APP_ID_ENV_VAR,
  DESKTOP_BUNDLE_IDENTIFIER,
  evaluateMacSignature,
  isCdhashKeyedRequirement,
  normalizeRequirement,
  parseCodesignDisplay,
  parseDesignatedRequirement,
} from "./mac-signature.ts";

/**
 * Both fixtures are verbatim `codesign` output, captured on 2026-08-11 from:
 *
 *   codesign --display --verbose=4 "/Applications/T3 Code (Alpha).app"   (the shipped fork build)
 *   codesign --display --verbose=4 <a bundle signed with a real certificate>
 *
 * Real output, not a hand-written approximation, because every bug this parser can have lives in
 * the difference between the two shapes — `Signature=adhoc` versus `Signature size=…`,
 * `Sealed Resources=none` versus `Sealed Resources version=…`, a requirement printed as a comment
 * versus one printed as a clause.
 */
const ADHOC_DISPLAY = `Executable=/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Hash type=sha256 size=32
CandidateCDHash sha256=d48d810e7b110d8d70a793f827dd23a7b2506405
CDHash=d48d810e7b110d8d70a793f827dd23a7b2506405
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`;

const ADHOC_REQUIREMENTS = `Executable=/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)
# designated => cdhash H"d48d810e7b110d8d70a793f827dd23a7b2506405"
`;

const SIGNED_DISPLAY = `Executable=/private/tmp/sigtest/A.app/Contents/MacOS/probe
Identifier=dev.curlycloud.t3coil
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=286 flags=0x10000(runtime) hashes=2+3 location=embedded
Hash type=sha256 size=32
CDHash=8e474702803ad42fe7e5855f2efd10af1eb75d94
Signature size=4793
Authority=T3 Coil Code Signing
Signed Time=Aug 11, 2026 at 18:43:41
Info.plist entries=4
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=1
Internal requirements count=1 size=192
`;

/**
 * The shape a self-signed certificate produces: no Apple anchor, so codesign pins the exact leaf.
 * Stable across rebuilds because the certificate does not change — which is the entire fix.
 */
const SELF_SIGNED_REQUIREMENT =
  'identifier "dev.curlycloud.t3coil" and certificate leaf = H"6dc6e7effe78c5b8406fde43b9afaaf5a85c8eba"';

describe("parseCodesignDisplay", () => {
  it("reads an ad-hoc bundle as having no certificate, no seal and an unbound Info.plist", () => {
    const display = parseCodesignDisplay(ADHOC_DISPLAY);

    assert.strictEqual(display.identifier, "Electron");
    assert.strictEqual(display.signature, "adhoc");
    assert.deepStrictEqual([...display.flags], ["adhoc", "linker-signed"]);
    assert.deepStrictEqual([...display.authorities], []);
    assert.strictEqual(display.sealedResources, undefined);
    assert.strictEqual(display.infoPlistBound, false);
    assert.strictEqual(display.teamIdentifier, undefined);
  });

  it("reads a certificate-signed bundle, whose Sealed Resources line has no '=' after the label", () => {
    const display = parseCodesignDisplay(SIGNED_DISPLAY);

    assert.strictEqual(display.identifier, "dev.curlycloud.t3coil");
    // `Signature size=4793` is not a `Signature=` field, and must not be read as one.
    assert.strictEqual(display.signature, undefined);
    assert.deepStrictEqual([...display.flags], ["runtime"]);
    assert.deepStrictEqual([...display.authorities], ["T3 Coil Code Signing"]);
    assert.strictEqual(display.sealedResources, "version=2 rules=13 files=1");
    assert.strictEqual(display.infoPlistBound, true);
  });

  it("keeps every Authority line, leaf first", () => {
    const display = parseCodesignDisplay(`Identifier=com.t3tools.t3code
Authority=Apple Development: someone@example.com (TEAMID1234)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
Sealed Resources version=2 rules=13 files=1
`);

    assert.strictEqual(
      display.authorities[0],
      "Apple Development: someone@example.com (TEAMID1234)",
    );
    assert.strictEqual(display.authorities.length, 3);
  });
});

describe("parseDesignatedRequirement", () => {
  it("reads the ad-hoc requirement, which codesign prints as a COMMENT", () => {
    assert.strictEqual(
      parseDesignatedRequirement(ADHOC_REQUIREMENTS),
      'cdhash H"d48d810e7b110d8d70a793f827dd23a7b2506405"',
    );
  });

  it("re-joins a requirement that codesign wrapped across lines", () => {
    const wrapped = `Executable=/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)
designated => identifier "com.t3tools.t3code" and anchor apple generic
	and certificate leaf[subject.CN] = "Apple Development: someone@example.com (TEAMID1234)"
	and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */
`;

    assert.strictEqual(
      parseDesignatedRequirement(wrapped),
      'identifier "com.t3tools.t3code" and anchor apple generic and certificate leaf[subject.CN] = ' +
        '"Apple Development: someone@example.com (TEAMID1234)" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */',
    );
  });

  it("stops at the next requirement clause", () => {
    const multiple = `designated => identifier "com.t3tools.t3code" and certificate leaf = H"abc"
host => anchor apple
`;

    assert.strictEqual(
      parseDesignatedRequirement(multiple),
      'identifier "com.t3tools.t3code" and certificate leaf = H"abc"',
    );
  });

  it("returns undefined when there is no designated requirement at all", () => {
    assert.strictEqual(parseDesignatedRequirement("Executable=/tmp/x\n"), undefined);
  });
});

describe("isCdhashKeyedRequirement", () => {
  it("recognises the unstable shape", () => {
    assert.strictEqual(
      isCdhashKeyedRequirement('cdhash H"d48d810e7b110d8d70a793f827dd23a7b2506405"'),
      true,
    );
  });

  it("does not mistake a certificate-keyed requirement for it", () => {
    assert.strictEqual(isCdhashKeyedRequirement(SELF_SIGNED_REQUIREMENT), false);
  });
});

describe("evaluateMacSignature", () => {
  it("calls the shipped ad-hoc build unsigned, and says why the grants do not survive", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(ADHOC_DISPLAY),
      requirement: parseDesignatedRequirement(ADHOC_REQUIREMENTS),
    });

    assert.strictEqual(verdict.kind, "unsigned");
    assert.ok(verdict.problems.some((problem) => problem.includes("ad-hoc signed")));
    assert.ok(verdict.problems.some((problem) => problem.includes("keyed to a cdhash")));
    assert.ok(verdict.problems.some((problem) => problem.includes("Electron")));
    assert.ok(verdict.problems.some((problem) => problem.includes("Sealed Resources=none")));
    assert.ok(verdict.problems.some((problem) => problem.includes("Info.plist=not bound")));
  });

  it("accepts a certificate-signed bundle whose requirement matches the recorded one", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(SIGNED_DISPLAY),
      requirement: SELF_SIGNED_REQUIREMENT,
      expectation: { requirement: SELF_SIGNED_REQUIREMENT, authority: "T3 Coil Code Signing" },
    });

    assert.deepStrictEqual([...verdict.problems], []);
    assert.strictEqual(verdict.kind, "stable");
    assert.strictEqual(verdict.requirement, SELF_SIGNED_REQUIREMENT);
    assert.strictEqual(verdict.authority, "T3 Coil Code Signing");
  });

  it("ignores whitespace differences between the recorded and actual requirement", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(SIGNED_DISPLAY),
      requirement: SELF_SIGNED_REQUIREMENT,
      expectation: { requirement: `\n  ${SELF_SIGNED_REQUIREMENT.replace(/ and /, "\n\tand ")}\n` },
    });

    assert.strictEqual(verdict.kind, "stable");
  });

  it("REJECTS a signed bundle whose identity changed — signed is not the same as unchanged", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(SIGNED_DISPLAY),
      requirement: SELF_SIGNED_REQUIREMENT,
      expectation: {
        requirement: 'identifier "com.t3tools.t3code" and certificate leaf = H"0000000000"',
      },
    });

    assert.strictEqual(verdict.kind, "unstable");
    assert.ok(
      verdict.problems.some((problem) => problem.includes("designated requirement changed")),
    );
  });

  it("rejects a signature that claims the wrong bundle id", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(
        SIGNED_DISPLAY.replace(DESKTOP_BUNDLE_IDENTIFIER, "com.example.other"),
      ),
      requirement: SELF_SIGNED_REQUIREMENT,
    });

    assert.strictEqual(verdict.kind, "unstable");
    assert.ok(verdict.problems.some((problem) => problem.includes("com.example.other")));
  });

  it("rejects an unexpected signing identity", () => {
    const verdict = evaluateMacSignature({
      display: parseCodesignDisplay(SIGNED_DISPLAY),
      requirement: SELF_SIGNED_REQUIREMENT,
      expectation: { authority: "Somebody Else" },
    });

    assert.strictEqual(verdict.kind, "unstable");
    assert.ok(verdict.problems.some((problem) => problem.includes("leaf authority")));
  });
});

describe("normalizeRequirement", () => {
  it("collapses codesign's line wrapping so recorded requirements compare equal", () => {
    assert.strictEqual(
      normalizeRequirement('  identifier "x"\n\tand anchor apple  \n'),
      'identifier "x" and anchor apple',
    );
  });
});

/**
 * The bundle id has to agree in three places, and nothing at runtime would notice if it stopped.
 *
 * `scripts/build-desktop-artifact.ts` is upstream-owned and carries only the escape hatch — an
 * upstream sync that reverts that one line leaves every fork build silently claiming
 * `com.t3tools.t3code` again, which puts it back to sharing one TCC row with upstream's nightly.
 * Equally, a build path that forgets to SET the variable ships the same regression. Both are cheap
 * to assert here and expensive to notice in the wild: the symptom is permission dialogs, days later,
 * on a machine that is not CI.
 */
it.layer(NodeServices.layer)("the fork's bundle id agrees everywhere", (it) => {
  const readRepoFile = (...segments: readonly string[]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return yield* fs.readFileString(path.join(import.meta.dirname, "..", "..", ...segments));
    });

  it.effect("build-desktop-artifact.ts still honours the T3X_DESKTOP_APP_ID override", () =>
    Effect.gen(function* () {
      const source = yield* readRepoFile("scripts", "build-desktop-artifact.ts");

      assert.match(
        source,
        /const DESKTOP_APP_ID = process\.env\.T3X_DESKTOP_APP_ID\?\.trim\(\) \|\| "com\.t3tools\.t3code"/,
        "the fork's app-id seam is gone from build-desktop-artifact.ts — a sync probably reverted it",
      );
    }),
  );

  it.effect("the release workflow builds with it", () =>
    Effect.gen(function* () {
      const workflow = yield* readRepoFile(".github", "workflows", "coil-release.yml");
      const match = new RegExp(`${DESKTOP_APP_ID_ENV_VAR}: (\\S+)`).exec(workflow);

      assert.ok(match, `${DESKTOP_APP_ID_ENV_VAR} is not set anywhere in coil-release.yml`);
      assert.strictEqual(match[1], DESKTOP_BUNDLE_IDENTIFIER);
    }),
  );

  it.effect(
    "the certificate setup signs its stub with it, so the recorded requirement matches",
    () =>
      Effect.gen(function* () {
        const script = yield* readRepoFile("scripts", "coil", "setup-mac-signing.sh");

        assert.match(script, new RegExp(`BUNDLE_ID="${DESKTOP_BUNDLE_IDENTIFIER}"`));
      }),
  );

  it.effect("the recorded designated requirement is the one this identifier produces", () =>
    Effect.gen(function* () {
      const recorded = yield* readRepoFile(
        "docs",
        "coil",
        "mac-signing",
        "designated-requirement.txt",
      );

      // Not a format check for its own sake. This file is what the release compares against, so a
      // requirement naming a different bundle id would fail every build with a confusing diff.
      assert.include(normalizeRequirement(recorded), `identifier "${DESKTOP_BUNDLE_IDENTIFIER}"`);
      assert.strictEqual(isCdhashKeyedRequirement(recorded), false);
    }),
  );
});
