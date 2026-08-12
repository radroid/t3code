/*
 * Downloads come from the fork's update relay, not GitHub's releases API.
 *
 * Every fork release is published as a GitHub *pre-release*, and
 * `api.github.com/repos/radroid/t3code/releases/latest` — which upstream's marketing site uses —
 * skips pre-releases and 404s for this repo. The relay already serves the same manifest the
 * desktop app's updater consumes, so the site and the app agree on what "latest" means by
 * construction rather than by coincidence.
 */
// Moved to the renamed relay by #71. Safe to move here, unlike in the desktop app: this page is
// fetched fresh on every visit, so it has no old copies of itself in the field. The old hostname
// still answers — it proxies to this one for builds that predate the rename — but pointing the
// site through a shim it does not need would just add a hop.
const MANIFEST_URL = "https://coil-update-relay.businesses.workers.dev/latest";
const CACHE_KEY = "coil-latest-manifest";

export const RELEASES_URL = "https://github.com/radroid/t3code/releases";

export interface ManifestAsset {
  platform: "darwin-arm64" | "win32-x64";
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  version: string;
  releaseTag: string;
  builtAt: string;
  changes: string[];
  assets: ManifestAsset[];
}

export async function fetchLatestManifest(): Promise<Manifest> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(MANIFEST_URL).then((r) => r.json());

  // Only cache a manifest that carries assets — a transient relay error must not stick
  // around for the rest of the session.
  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}

export function findAsset(
  manifest: Manifest,
  platform: ManifestAsset["platform"],
): ManifestAsset | undefined {
  return manifest.assets?.find((a) => a.platform === platform);
}

export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}
