#!/usr/bin/env node
/**
 * Fail a build that would re-ask the user for every macOS permission.
 *
 * Issue #70. electron-builder does NOT fail when it cannot find a signing identity — it logs
 * `skipped macOS application code signing` as a warning and produces an ad-hoc bundle. That is the
 * failure mode worth spending a script on: the release goes green, the dmg installs, and the bug
 * reappears three days later as "the permission prompts are back", with nothing in the log anyone
 * would think to re-read.
 *
 * So the claim "this release keeps its permissions" is made machine-checkable here, against the
 * artifact that is actually shipped — the .app inside the .dmg, not the staging copy.
 *
 * Usage:
 *   node scripts/t3x/verify-mac-signature.ts --artifact release/T3-Code-0.0.33-arm64.dmg \
 *     --expect-requirement-file docs/t3x/mac-signing/designated-requirement.txt
 *   node scripts/t3x/verify-mac-signature.ts --artifact "/Applications/T3 Code (Alpha).app" \
 *     --write-requirement-file docs/t3x/mac-signing/designated-requirement.txt
 *   node scripts/t3x/verify-mac-signature.ts --artifact … --allow-unsigned   # warn, don't fail
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  evaluateMacSignature,
  formatMacSignatureVerdict,
  MAC_SIGNING_IDENTITY_NAME,
  normalizeRequirement,
  parseCodesignDisplay,
  parseDesignatedRequirement,
  type MacSignatureVerdict,
} from "./mac-signature.ts";

export class MacSignatureVerificationError extends Schema.TaggedErrorClass<MacSignatureVerificationError>()(
  "MacSignatureVerificationError",
  {
    artifactPath: Schema.String,
    problems: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      `macOS signature verification failed for ${this.artifactPath}:`,
      ...this.problems.map((problem) => `  - ${problem}`),
      "",
      "Every macOS permission grant is keyed to the app's designated requirement, so shipping this",
      "artifact would re-request Screen Recording, Accessibility, Microphone, Files & Folders and",
      "Local Network. See docs/t3x/mac-signing-runbook.md.",
    ].join("\n");
  }
}

export class MacArtifactNotFoundError extends Schema.TaggedErrorClass<MacArtifactNotFoundError>()(
  "MacArtifactNotFoundError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `No such artifact: ${this.artifactPath}`;
  }
}

export class MacAppNotFoundInDmgError extends Schema.TaggedErrorClass<MacAppNotFoundInDmgError>()(
  "MacAppNotFoundInDmgError",
  { dmgPath: Schema.String, mountPoint: Schema.String },
) {
  override get message(): string {
    return `No .app found at the top level of ${this.dmgPath} (mounted at ${this.mountPoint})`;
  }
}

/** Same shape as build-desktop-artifact.ts's collector: the initial value is a thunk, data-last. */
const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator: string, chunk: string) => accumulator + chunk,
    ),
  );

/**
 * `codesign` writes its report to STDERR, so both streams are collected and concatenated. Reading
 * stdout alone yields "" — which parses as an unsigned bundle and would fail every signed build.
 *
 * Self-scoping (`Effect.scoped` at the end), not relying on an ambient scope. Spawning acquires a
 * scoped resource, and one of the callers below is a RELEASE action — where no ambient scope is
 * available any more. That combination is how the first version of this file silently skipped its
 * `hdiutil detach`: the spawn failed with "Service not found: effect/Scope" and the failure was
 * swallowed, leaving the dmg attached and the temp mount point un-removable.
 */
const runCapturing = (bin: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(bin, [...args]));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { output: `${stdout}\n${stderr}`, exitCode } as const;
  }).pipe(Effect.scoped);

/**
 * Mount a dmg read-only and hand the caller the `.app` inside it.
 *
 * Two things are deliberate, and both are inherited from
 * apps/desktop/src/t3x/updateDelivery/installCommands.ts, where they were learned the hard way:
 *
 * - The mount point lives under $TMPDIR, never /Volumes. Mounting under /Volumes raises the macOS
 *   "access files on a removable volume" prompt, which a CI step cannot answer.
 * - `-readonly`: verification must never be able to modify the artifact it is verifying.
 *
 * The detach is a release action, so a failed verification still unmounts — a dmg left attached
 * poisons the next attach to the same mount point.
 */
const withMountedDmg = <A, E, R>(
  dmgPath: string,
  use: (appPath: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mountPoint = yield* fs.makeTempDirectoryScoped({ prefix: "t3x-verify-sig-" });

    yield* Effect.acquireRelease(
      runCapturing("hdiutil", [
        "attach",
        dmgPath,
        "-nobrowse",
        "-readonly",
        "-quiet",
        "-mountpoint",
        mountPoint,
      ]),
      () =>
        runCapturing("hdiutil", ["detach", mountPoint, "-force"]).pipe(
          // Never blanket-ignored. A failed detach leaves the image attached, which poisons the
          // next attach to the same mount point — and the temp directory's own removal then fails
          // with EBUSY, reporting a mounting problem as a filesystem one. catchCause, not
          // catchError: the failure that actually happened here was a defect.
          Effect.catchCause((cause) =>
            Effect.logWarning(`[mac-signature] could not detach ${mountPoint}: ${cause}`),
          ),
        ),
    );

    const entries = yield* fs.readDirectory(mountPoint);
    const appEntry = entries.find((entry) => entry.endsWith(".app"));
    if (appEntry === undefined) {
      return yield* new MacAppNotFoundInDmgError({ dmgPath, mountPoint });
    }

    return yield* use(path.join(mountPoint, appEntry));
  }).pipe(Effect.scoped);

/** Everything codesign has to say about one bundle, reduced to a verdict. */
export const inspectMacSignature = Effect.fn("inspectMacSignature")(function* (
  appPath: string,
  expectation: {
    readonly requirement?: string | undefined;
    readonly authority?: string | undefined;
  },
) {
  const display = yield* runCapturing("codesign", ["--display", "--verbose=4", appPath]);
  const requirements = yield* runCapturing("codesign", [
    "--display",
    "--requirements",
    "-",
    appPath,
  ]);
  // --deep so nested helpers, frameworks and the packaged native binaries are validated too: a
  // bundle whose top-level signature is fine but whose helper is not fails to launch, and TCC
  // grants are attached to the helper's responsible process.
  const verify = yield* runCapturing("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=1",
    appPath,
  ]);

  const verdict = evaluateMacSignature({
    display: parseCodesignDisplay(display.output),
    requirement: parseDesignatedRequirement(requirements.output),
    expectation: {
      requirement: expectation.requirement,
      authority: expectation.authority,
    },
  });

  const problems =
    verify.exitCode === 0
      ? verdict.problems
      : [
          ...verdict.problems,
          `codesign --verify --deep --strict failed (exit ${verify.exitCode}): ${verify.output.trim()}`,
        ];

  return { ...verdict, problems } satisfies MacSignatureVerdict;
});

const verifyMacSignature = Effect.fn("verifyMacSignature")(function* (input: {
  readonly artifact: string;
  readonly expectRequirementFile: string | undefined;
  readonly writeRequirementFile: string | undefined;
  readonly expectAuthority: string | undefined;
  readonly allowUnsigned: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifactPath = path.resolve(input.artifact);

  if (!(yield* fs.exists(artifactPath))) {
    return yield* new MacArtifactNotFoundError({ artifactPath });
  }

  const expectedRequirement =
    input.expectRequirementFile === undefined
      ? undefined
      : normalizeRequirement(yield* fs.readFileString(path.resolve(input.expectRequirementFile)));

  const inspect = (appPath: string) =>
    inspectMacSignature(appPath, {
      requirement: expectedRequirement,
      authority: input.expectAuthority,
    });

  const verdict = artifactPath.endsWith(".dmg")
    ? yield* withMountedDmg(artifactPath, inspect)
    : yield* inspect(artifactPath);

  yield* Effect.log(`[mac-signature] ${artifactPath}\n  ${formatMacSignatureVerdict(verdict)}`);

  if (verdict.kind === "stable" && input.writeRequirementFile !== undefined) {
    const requirementPath = path.resolve(input.writeRequirementFile);
    yield* fs.writeFileString(requirementPath, `${verdict.requirement ?? ""}\n`);
    yield* Effect.log(`[mac-signature] recorded designated requirement -> ${requirementPath}`);
  }

  if (verdict.kind === "stable") {
    yield* Effect.log("[mac-signature] permissions granted to this app will survive updates.");
    return;
  }

  // An unsigned artifact is the pre-#70 status quo, so a caller that has no signing identity
  // available (a local build on a fresh machine, a fork clone) can opt into a warning. An UNSTABLE
  // one never gets that option: it is signed, so it looks fixed, and it is not.
  if (verdict.kind === "unsigned" && input.allowUnsigned) {
    yield* Effect.logWarning(
      [
        "[mac-signature] this artifact is ad-hoc signed: installing it will re-request every macOS",
        `permission, and will do so again on the next build. Create the '${MAC_SIGNING_IDENTITY_NAME}'`,
        "identity with scripts/t3x/setup-mac-signing.sh to stop that.",
        ...verdict.problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    return;
  }

  return yield* new MacSignatureVerificationError({ artifactPath, problems: verdict.problems });
});

export const verifyMacSignatureCommand = Command.make(
  "verify-mac-signature",
  {
    artifact: Flag.string("artifact").pipe(
      Flag.withDescription("Path to the built .dmg, or to a .app bundle."),
    ),
    expectRequirementFile: Flag.string("expect-requirement-file").pipe(
      Flag.withDescription(
        "File holding the designated requirement every release must match, byte for byte.",
      ),
      Flag.optional,
    ),
    writeRequirementFile: Flag.string("write-requirement-file").pipe(
      Flag.withDescription(
        "Record this artifact's designated requirement to a file (only when the verdict is stable).",
      ),
      Flag.optional,
    ),
    expectAuthority: Flag.string("expect-authority").pipe(
      Flag.withDescription("Signing identity name the leaf Authority must equal."),
      Flag.optional,
    ),
    allowUnsigned: Flag.boolean("allow-unsigned").pipe(
      Flag.withDescription(
        "Warn instead of failing when no signing identity was used. Never allows a CHANGED identity.",
      ),
      Flag.optional,
    ),
  },
  ({ artifact, expectRequirementFile, writeRequirementFile, expectAuthority, allowUnsigned }) =>
    verifyMacSignature({
      artifact,
      expectRequirementFile: Option.getOrUndefined(expectRequirementFile),
      writeRequirementFile: Option.getOrUndefined(writeRequirementFile),
      expectAuthority: Option.getOrUndefined(expectAuthority),
      allowUnsigned: Option.getOrElse(allowUnsigned, () => false),
    }),
).pipe(
  Command.withDescription(
    "Verify a macOS artifact is signed with a stable identity, so permission grants survive updates.",
  ),
);

if (import.meta.main) {
  // Effect.scoped, matching build-desktop-artifact.ts: spawning a child process acquires a scoped
  // resource, so without it every codesign call dies with "Service not found: effect/Scope".
  Command.run(verifyMacSignatureCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
