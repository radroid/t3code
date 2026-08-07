/**
 * Getting the announced build onto this disk, swap-ready, before the user is told anything.
 *
 * The user chose "pre-download quietly, click = instant restart". That only holds if everything
 * expensive happens here: the ~470 MB download, the checksum, the dmg mount, the full bundle copy
 * and the recursive de-quarantine. What remains for the click is a delete and a rename.
 *
 * Nothing in this file is silent about failure. Every abandoned attempt returns a
 * `StagingError` the service turns into a visible `failed` state — the 103-minute outage in
 * issue #41 was invisible precisely because the failing path had no way to speak.
 */

import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  type Command,
  macAttachCommands,
  macCopyCommands,
  macDetachCommand,
} from "./installCommands.ts";
import {
  describeRefusal,
  findEnclosingAppBundle,
  isTranslocatedPath,
  resolveMacInstallTarget,
  stagedBundlePath,
} from "./installTarget.ts";
import type { UpdateAsset, UpdateManifest } from "./manifest.ts";
import { checkDiskSpace, partialDownloadName, selectStagingSweep, verifyChecksum } from "./staging.ts";

export class StagingError extends Schema.TaggedErrorClass<StagingError>()("T3xStagingError", {
  step: Schema.Literals([
    "disk-space",
    "download",
    "checksum",
    "mount",
    "read-bundle-name",
    "resolve-target",
    "copy",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Update staging failed at ${this.step}: ${this.detail}`;
  }
}

/** What the click needs, recorded once staging succeeds. */
export interface StagedBuild {
  readonly shortSha: string;
  readonly version: string;
  /** macOS: the `.app` that will be renamed into place. Windows: the downloaded installer. */
  readonly artifactPath: string;
  readonly targetPath: string;
  readonly appName: string;
}

const runCommand = Effect.fn("t3x.updateDelivery.run")(function* (
  command: Command,
  step: StagingError["step"],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(command.bin, [...command.args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  const exitCode = yield* handle.exitCode;
  if ((exitCode as unknown as number) !== 0) {
    return yield* new StagingError({
      step,
      detail: `${command.bin} exited ${String(exitCode)}`,
    });
  }
}, Effect.scoped);

/**
 * `xattr -d` exits non-zero when the attribute is absent, which is the common case — a dmg this
 * app downloaded itself was never quarantined. Only the surrounding steps are allowed to fail the
 * staging run; treating "there was nothing to remove" as an error would fail every clean install.
 */
const runOptionalXattr = (command: Command, step: StagingError["step"]) =>
  command.bin === "xattr" ? runCommand(command, step).pipe(Effect.ignore) : runCommand(command, step);

/**
 * Free bytes, parsed out of `df -Pk`.
 *
 * `-P` is the point: it forces the POSIX output format, which guarantees one line per filesystem
 * and a fixed column order. Without it, a long device name wraps onto its own line and the
 * "available" column moves — a misparse that would let a download start on a disk that cannot
 * hold it.
 *
 * Exported for its test. Returns `undefined` for anything it does not fully recognise, and the
 * caller treats that as "skip the check": being unable to measure free space is not evidence that
 * there is none, and refusing an update over an unreadable `df` would be worse than the disk
 * filling up.
 */
export function parseDfAvailableBytes(output: string): number | undefined {
  const lines = output.trim().split("\n");
  if (lines.length < 2) return undefined;
  const columns = lines[1]?.trim().split(/\s+/u) ?? [];
  // Filesystem, 1024-blocks, Used, Available, Capacity, Mounted-on
  const available = Number(columns[3]);
  return Number.isSafeInteger(available) && available >= 0 ? available * 1024 : undefined;
}

const freeBytesOn = Effect.fn("t3x.updateDelivery.freeBytes")(function* (path: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("df", ["-Pk", path], { stdin: "ignore", stderr: "ignore" }),
  );
  const output = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return parseDfAvailableBytes(output);
}, Effect.scoped);

/**
 * Following redirects is load-bearing here, not defensive hygiene.
 *
 * A GitHub release asset URL (`/releases/download/<tag>/<file>`) ALWAYS answers 302 with a signed,
 * short-lived `release-assets.githubusercontent.com` location. The bytes are never served from
 * github.com. The desktop app provides `NodeHttpClient.layerUndici` (main.ts), and undici does not
 * follow redirects unless asked — so every update attempt died on the status check in
 * `downloadAsset` with "HTTP 302 for https://github.com/...", which reads like a GitHub fault
 * rather than a client that stopped one hop early.
 *
 * Named and exported so the redirect hop is covered by a test: inlining the `.pipe(...)` made the
 * one thing that broke the whole update path invisible to the suite.
 */
export const assetDownloadClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(HttpClient.followRedirects());

/**
 * Download the asset, hashing as the bytes arrive.
 *
 * One pass, not two. Re-reading 470 MB from disk to checksum it doubles the I/O for no benefit,
 * and on this machine — which runs at 95 percent full — the download is already the expensive part.
 *
 * Writes to `<name>.part` and renames only after the checksum matches, so a crash mid-download can
 * never leave a file that looks complete. `selectStagingSweep` deletes `.part` files
 * unconditionally on the next run: their bytes were never verified, so they cannot be resumed.
 */
const downloadAsset = Effect.fn("t3x.updateDelivery.download")(function* (args: {
  readonly asset: UpdateAsset;
  readonly finalPath: string;
  readonly partialPath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const client = assetDownloadClient(yield* HttpClient.HttpClient);

  const response = yield* client
    .get(args.asset.url)
    .pipe(
      Effect.mapError((cause) => new StagingError({ step: "download", detail: cause.message })),
    );
  if (response.status < 200 || response.status >= 300) {
    return yield* new StagingError({
      step: "download",
      detail: `HTTP ${response.status} for ${args.asset.url}`,
    });
  }

  const hash = NodeCrypto.createHash("sha256");

  yield* Effect.gen(function* () {
    const file = yield* fileSystem.open(args.partialPath, { flag: "w" });
    yield* response.stream.pipe(
      Stream.runForEach((bytes: Uint8Array) =>
        Effect.suspend(() => {
          hash.update(bytes);
          return file.writeAll(bytes);
        }),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new StagingError({ step: "download", detail: String(cause) })),
  );

  const verdict = verifyChecksum(args.asset.sha256, hash.digest("hex"));
  if (verdict.kind === "mismatch") {
    yield* fileSystem.remove(args.partialPath).pipe(Effect.ignore);
    return yield* new StagingError({
      step: "checksum",
      detail: `expected ${verdict.expected}, got ${verdict.actual}`,
    });
  }

  yield* fileSystem
    .rename(args.partialPath, args.finalPath)
    .pipe(
      Effect.mapError((cause) => new StagingError({ step: "download", detail: String(cause) })),
    );
});

/**
 * Delete everything in the staging directory that is not the build being staged.
 *
 * Runs before every download, not only after a successful install, because the case that matters
 * is the one where no install ever completed — the app was quit mid-stage and nothing ran cleanup.
 */
const sweepStagingDir = Effect.fn("t3x.updateDelivery.sweep")(function* (args: {
  readonly stagingDir: string;
  readonly keepShortSha: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const names = yield* fileSystem.readDirectory(args.stagingDir).pipe(Effect.orElseSucceed(() => []));
  const sweep = selectStagingSweep({
    entries: names.map((name) => ({ name, shortSha: shortShaFromName(name) })),
    targetShortSha: args.keepShortSha,
  });
  for (const entry of sweep) {
    yield* fileSystem
      .remove(environment.path.join(args.stagingDir, entry.name), { recursive: true })
      .pipe(Effect.ignore);
  }
});

/** Staged files are named `<shortSha>-<original>`, so the sweep can tell them apart by name alone. */
export function stagedFileName(shortSha: string, assetFile: string): string {
  return `${shortSha}-${assetFile}`;
}

function shortShaFromName(name: string): string | undefined {
  const match = /^([0-9a-f]{12})-/u.exec(name);
  return match?.[1];
}

/**
 * Stage a build so the click is a rename.
 *
 * macOS only mounts and copies; Windows stops at the verified installer, because an NSIS installer
 * cannot be "pre-applied" — it needs the app's own files, so it can only run after the app quits.
 * That asymmetry is real and the design says so: macOS restarts itself, Windows is restarted *by*
 * the installer.
 */
export const stageUpdate = Effect.fn("t3x.updateDelivery.stage")(function* (args: {
  readonly manifest: UpdateManifest;
  readonly asset: UpdateAsset;
  readonly execPath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  const stagingDir = environment.path.join(environment.stateDir, "t3x-updates");
  yield* fileSystem
    .makeDirectory(stagingDir, { recursive: true })
    .pipe(
      Effect.mapError((cause) => new StagingError({ step: "download", detail: String(cause) })),
    );

  yield* sweepStagingDir({ stagingDir, keepShortSha: args.manifest.shortSha });

  const free = yield* freeBytesOn(stagingDir).pipe(Effect.orElseSucceed(() => undefined));
  if (free !== undefined) {
    const disk = checkDiskSpace({ assetBytes: args.asset.bytes, freeBytes: free });
    if (disk.kind === "insufficient") {
      return yield* new StagingError({
        step: "disk-space",
        detail: `needs ${disk.requiredBytes} bytes, ${disk.freeBytes} free`,
      });
    }
  }

  const finalName = stagedFileName(args.manifest.shortSha, args.asset.file);
  const finalPath = environment.path.join(stagingDir, finalName);
  const partialPath = environment.path.join(stagingDir, partialDownloadName(finalName));

  const alreadyThere = yield* fileSystem.exists(finalPath).pipe(Effect.orElseSucceed(() => false));
  if (!alreadyThere) {
    yield* downloadAsset({ asset: args.asset, finalPath, partialPath });
  }

  if (environment.platform !== "darwin") {
    // Windows: the verified installer IS the staged artifact. `targetPath` is the installed
    // executable, recorded so the post-install check on the next launch has something to compare.
    return {
      shortSha: args.manifest.shortSha,
      version: args.manifest.version,
      artifactPath: finalPath,
      targetPath: args.execPath,
      appName: environment.path.basename(args.execPath),
    } satisfies StagedBuild;
  }

  // Refused before mounting anything: a translocated app cannot be updated in place, and finding
  // that out after a 470 MB copy wastes the copy.
  if (isTranslocatedPath(args.execPath) || findEnclosingAppBundle(args.execPath) === undefined) {
    return yield* new StagingError({
      step: "resolve-target",
      detail: `cannot resolve an installed .app from ${args.execPath}`,
    });
  }

  const mountPoint = environment.path.join(stagingDir, `mnt-${args.manifest.shortSha}`);
  yield* fileSystem.remove(mountPoint, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem
    .makeDirectory(mountPoint, { recursive: true })
    .pipe(Effect.mapError((cause) => new StagingError({ step: "mount", detail: String(cause) })));

  const mounted = Effect.gen(function* () {
    for (const command of macAttachCommands({ dmgPath: finalPath, mountPoint })) {
      yield* runOptionalXattr(command, "mount");
    }

    const mountedNames = yield* fileSystem
      .readDirectory(mountPoint)
      .pipe(Effect.orElseSucceed(() => []));
    const incomingAppName = mountedNames.find((name) => name.endsWith(".app"));
    if (incomingAppName === undefined) {
      return yield* new StagingError({
        step: "read-bundle-name",
        detail: `no .app inside ${finalName}`,
      });
    }

    const resolution = resolveMacInstallTarget({ execPath: args.execPath, incomingAppName });
    if (resolution.kind === "refused") {
      return yield* new StagingError({
        step: "resolve-target",
        detail: describeRefusal(resolution.refusal),
      });
    }

    const stagedAppPath = stagedBundlePath(resolution.appBundlePath);
    for (const command of macCopyCommands({
      sourceAppPath: environment.path.join(mountPoint, incomingAppName),
      stagedAppPath,
    })) {
      yield* runOptionalXattr(command, "copy");
    }

    return {
      shortSha: args.manifest.shortSha,
      version: args.manifest.version,
      artifactPath: stagedAppPath,
      targetPath: resolution.appBundlePath,
      appName: resolution.appName,
    } satisfies StagedBuild;
  });

  return yield* mounted.pipe(
    Effect.ensuring(runCommand(macDetachCommand(mountPoint), "mount").pipe(Effect.ignore)),
  );
});
