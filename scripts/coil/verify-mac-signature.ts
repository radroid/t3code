#!/usr/bin/env node
/**
 * Fail a build that would re-ask the user for every macOS permission. electron-builder only warns
 * when no signing identity is found and ships an ad-hoc bundle, so this checks the shipped .app
 * (inside the .dmg). Flags: --artifact <dmg|app>, --expect-requirement-file <f> or
 * --write-requirement-file <f>, and --allow-unsigned to warn instead of fail.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  evaluateMacSignature,
  formatMacSignatureVerdict,
  MAC_SIGNING_IDENTITY_NAME,
  normalizeRequirement,
  parseCodesignDisplay,
  parseDesignatedRequirement,
  type MacSignatureVerdict,
} from "./mac-signature.ts";

export class MacSignatureVerificationError extends Schema.TaggedError<MacSignatureVerificationError>()(
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
      "Local Network. See docs/coil/mac-signing-runbook.md.",
    ].join("\n");
  }
}

export class MacArtifactNotFoundError extends Schema.TaggedError<MacArtifactNotFoundError>()(
  "MacArtifactNotFoundError",
  { artifactPath: Schema.String },
) {
  override get message(): string {
    return `No such artifact: ${this.artifactPath}`;
  }
}

export class MacAppNotFoundInDmgError extends Schema.TaggedError<MacAppNotFoundInDmgError>()(
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
 * `codesign` reports on STDERR, so both streams are collected; stdout alone parses as unsigned.
 * Self-scoping (`Effect.scoped`) because a caller runs this in a release action, where there is
 * no ambient scope: without it the spawn fails silently and the dmg is never detached.
 */
const runCapturing = Effect.fn("runCapturing")(function* (bin: string, args: readonly string[]) {
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
}, Effect.scoped);

/**
 * Mount a dmg `-readonly` under $TMPDIR (never /Volumes, whose removable-volume prompt CI cannot
 * answer) and hand the caller the `.app` inside, as installCommands.ts does. The detach is a
 * release action, so a failed verification still unmounts and cannot poison the next attach.
 */
const withMountedDmg = Effect.fn("withMountedDmg")(function* <A, E, R>(
  dmgPath: string,
  use: (appPath: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mountPoint = yield* fs.makeTempDirectoryScoped({ prefix: "coil-verify-sig-" });

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
}, Effect.scoped);

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
        "identity with scripts/coil/setup-mac-signing.sh to stop that.",
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
    artifact: Flag.String("artifact").pipe(
      Flag.withDescription("Path to the built .dmg, or to a .app bundle."),
    ),
    expectRequirementFile: Flag.String("expect-requirement-file").pipe(
      Flag.withDescription(
        "File holding the designated requirement every release must match, byte for byte.",
      ),
      Flag.optional,
    ),
    writeRequirementFile: Flag.String("write-requirement-file").pipe(
      Flag.withDescription(
        "Record this artifact's designated requirement to a file (only when the verdict is stable).",
      ),
      Flag.optional,
    ),
    expectAuthority: Flag.String("expect-authority").pipe(
      Flag.withDescription("Signing identity name the leaf Authority must equal."),
      Flag.optional,
    ),
    allowUnsigned: Flag.Boolean("allow-unsigned").pipe(
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
