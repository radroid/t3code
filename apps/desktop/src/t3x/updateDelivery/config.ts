/**
 * Where the running app looks for update announcements, and what it believes it already is.
 *
 * Both answers have to come from somewhere that survives packaging. Neither can come from
 * `process.env`: a `.app` launched from Finder inherits `launchd`'s environment, not a shell's,
 * so an env var set in a terminal is simply absent at runtime. That is the same trap that made
 * `T3CODE_DISABLE_AUTO_UPDATE` unusable as a delivery mechanism — see the design doc's provenance
 * table. Env vars here are a development convenience only, and the packaged path never needs one.
 */

import { SHORT_SHA_LENGTH } from "./manifest.ts";

/**
 * The fork's relay, deployed from `infra/t3x-update-relay/`.
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
 * The build counter of the running app, read out of its own version string.
 *
 * `t3x-release.yml` builds `<base>-t3x.<run_number>` and `build-update-manifest.mjs` asserts that
 * the manifest's `buildNumber` is that same number, so parsing it back out here is reading the
 * value the release wrote — not re-deriving it. An upstream build (`0.0.31`, no suffix) yields
 * `undefined`, which `decideUpdateAction` treats as "no floor", so the first fork build installs.
 */
export function parseBuildNumber(version: string): number | undefined {
  const match = /-t3x\.(\d+)$/u.exec(version.trim());
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
