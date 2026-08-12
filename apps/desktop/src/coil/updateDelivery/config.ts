/**
 * Where the running app looks for update announcements, and what it believes it already is.
 *
 * Both answers have to come from somewhere that survives packaging. Neither can come from
 * `process.env`: a `.app` launched from Finder inherits `launchd`'s environment, not a shell's,
 * so an env var set in a terminal is simply absent at runtime. That is the same trap that made
 * `T3CODE_DISABLE_AUTO_UPDATE` unusable as a delivery mechanism — see the design doc's provenance
 * table. Env vars here are a development convenience only, and the packaged path never needs one.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { SHORT_SHA_LENGTH } from "./manifest.ts";

/**
 * The fork's relay, deployed from `infra/coil-update-relay/`.
 *
 * Hardcoded rather than injected at build time. It is a public URL that serves public release
 * metadata, it is stable across every build, and baking it in through the packaged `package.json`
 * would mean editing `scripts/build-desktop-artifact.ts` — an upstream file this fork does not
 * touch, and a seam row that buys nothing.
 */
export const DEFAULT_RELAY_URL = "https://t3x-update-relay.businesses.workers.dev";

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
export function resolveRelayUrl(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if ((env[DISABLE_ENV_VAR] ?? "").trim() !== "") return undefined;
  const override = (env[RELAY_URL_ENV_VAR] ?? "").trim();
  return override === "" ? DEFAULT_RELAY_URL : override;
}

/**
 * Marker recording that this install has applied at least one update through this path.
 *
 * A file rather than a field in memory, because the fact it records survives exactly one event:
 * the restart it is about. An in-memory flag set just before `app.exit` is gone by the time the
 * new build asks the question, so the "macOS will ask for permissions again" note — meant to be
 * shown once — would be shown on every single update instead, which is how a warning becomes
 * wallpaper.
 *
 * A file rather than `DesktopClientSettings`, because that is an upstream-owned persisted schema
 * and this is one bit that only the fork cares about.
 */
export const UPDATED_MARKER_NAME = ".t3x-has-updated";

/**
 * What the marker records about the install that is about to happen.
 *
 * The marker used to be written empty, which made it answer only "has this app ever updated?".
 * `installCommands.ts` documents a second job for it — "the target is recorded before quitting and
 * compared against `t3codeCommitHash` when the app comes back" — and that half was never built, so
 * a silently failed install was indistinguishable from a successful one. On Windows the app is
 * gone for minutes during the install, so "did that work?" is not a question the user can answer
 * by looking.
 *
 * Written before quitting, read once on the next boot, then cleared. Only the target is stored:
 * the running build reports its own identity, and comparing two values written at different times
 * by different processes is the entire point.
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
 * The build counter of the running app, read out of its own version string.
 *
 * `coil-release.yml` builds `<base>-coil.<counter>` and `build-update-manifest.mjs` asserts that
 * the manifest's `buildNumber` is that same number, so parsing it back out here is reading the
 * value the release wrote — not re-deriving it. An upstream build (`0.0.31`, no suffix) yields
 * `undefined`, which `decideUpdateAction` treats as "no floor", so the first fork build installs.
 *
 * Both suffixes, because this function is asked about two different version strings. The obvious
 * one is the running app's own, and for a `-t3x.` build that is answered by the `-t3x.`-only code
 * it shipped with — this branch never runs there. The one that matters is the version the app is
 * asked to *compare against* around the cutover: a build carrying this code can still be offered,
 * or be preceded by, a `-t3x.` release. Returning `undefined` for those would erase the floor
 * entirely and make a genuinely older build look installable.
 *
 * Note the numbers stay comparable across the rename by construction, not by luck: the counter is
 * `github.run_number + 100` precisely so `-coil.101` outranks `-t3x.26`. Nothing here compares the
 * suffixes themselves, which is fortunate — `coil` sorts before `t3x`.
 */
export function parseBuildNumber(version: string): number | undefined {
  const match = /-(?:coil|t3x)\.(\d+)$/u.exec(version.trim());
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The commit of the running app, from the `t3codeCommitHash` that
 * `scripts/build-desktop-artifact.ts` writes into the packaged `package.json`.
 *
 * Read here rather than through `DesktopAppIdentity`, which computes the same value but does not
 * expose it on its service interface. Adding an accessor there would put an upstream file that the
 * fork does not currently edit into the seam ledger, to reach a field this can parse itself.
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
