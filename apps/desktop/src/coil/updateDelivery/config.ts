/**
 * Where the running app looks for update announcements, and what it believes it already is.
 * Neither can come from `process.env`: a `.app` launched from Finder inherits `launchd`'s
 * environment, not a shell's. Env vars here are a development convenience only.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SHORT_SHA_LENGTH } from "./manifest.ts";

/**
 * The fork's relay, deployed from `infra/coil-update-relay/`. Hardcoded, so every shipped build
 * keeps its hostname forever. A retired hostname must stay deployed as a pass-through (see
 * `infra/coil-update-relay/src/legacyWorker.ts`); changing this without one silently strands
 * every older install.
 */
export const DEFAULT_RELAY_URL = "https://coil-update-relay.businesses.workers.dev";

export const RELAY_URL_ENV_VAR = "T3X_UPDATE_RELAY_URL";

/** Set to any non-empty value to turn delivery off for a session. Development only. */
export const DISABLE_ENV_VAR = "T3X_DISABLE_UPDATE_DELIVERY";

export interface RelayEndpoints {
  readonly events: string;
  readonly latest: string;
}

export function relayEndpoints(baseUrl: string): RelayEndpoints {
  const trimmed = baseUrl.replace(/\/+$/u, "");
  return { events: `${trimmed}/events`, latest: `${trimmed}/latest` };
}

/**
 * The relay URL for this run.
 *
 * Returns `undefined` when delivery is disabled, so the caller starts nothing at all rather than
 * starting a subscriber that immediately parks. A disabled feature that still holds a socket open
 * is a disabled feature that can still page you at 3am.
 */
export function resolveRelayUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if ((env[DISABLE_ENV_VAR] ?? "").trim() !== "") return undefined;
  const override = (env[RELAY_URL_ENV_VAR] ?? "").trim();
  return override === "" ? DEFAULT_RELAY_URL : override;
}

/**
 * Marker recording that this install has applied at least one update through this path. A file,
 * because an in-memory flag set before `app.exit` is gone when the new build asks (so the
 * once-only App Management note would show on every update), and not `DesktopClientSettings`,
 * because that is an upstream-owned schema.
 */
export const UPDATED_MARKER_NAME = ".t3x-has-updated";

/**
 * The target of the install about to happen: written before quitting, read once on the next boot,
 * then cleared. The new build reports its own identity, so comparing the two catches a silently
 * failed install (on Windows the app is gone for minutes, so the user cannot tell by looking).
 */
export const PendingInstall = Schema.Struct({
  shortSha: Schema.String,
  version: Schema.String,
});
export type PendingInstall = typeof PendingInstall.Type;

/**
 * A marker written by any build before this change contains an empty string, and one written by a
 * build after it contains an encoded `PendingInstall`. Both have to decode: the empty case is a
 * real state ("this app has updated before, and nothing is pending"), not corruption, and treating
 * it as corruption would resurrect the permission note on an app that had already seen it.
 */
/** Compiled once. Both the schema literal and the codec are otherwise rebuilt on every call. */
const PendingInstallJson = Schema.fromJsonString(PendingInstall);
const decodePendingInstallJson = Schema.decodeUnknownOption(PendingInstallJson);
const encodePendingInstallJson = Schema.encodeSync(PendingInstallJson);

export function parsePendingInstall(raw: string): PendingInstall | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return decodePendingInstallJson(trimmed).pipe(Option.getOrUndefined);
}

/** The write side of {@link parsePendingInstall}, so both ends of the marker share one schema. */
export function encodePendingInstall(target: PendingInstall): string {
  return encodePendingInstallJson(target);
}

/**
 * The build counter from a `-coil.<n>` or `-t3x.<n>` version suffix. Both suffixes, because around
 * the rename a build can be compared against a `-t3x.` release and `undefined` would erase the
 * floor. Counters stay ordered because `coil-release.yml` uses `github.run_number + 100`; never
 * compare the suffixes themselves (`coil` sorts before `t3x`).
 */
export function parseBuildNumber(version: string): number | undefined {
  const match = /-(?:coil|t3x)\.(\d+)$/u.exec(version.trim());
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The commit of the running app, from the `t3codeCommitHash` that
 * `scripts/build-desktop-artifact.ts` writes into the packaged `package.json`. Parsed here because
 * `DesktopAppIdentity` does not expose it, and adding an accessor would mean editing upstream.
 */
export function readEmbeddedCommitHash(packageJsonText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = (parsed as { readonly t3codeCommitHash?: unknown }).t3codeCommitHash;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/u.test(trimmed) ? trimmed.slice(0, SHORT_SHA_LENGTH) : undefined;
}
