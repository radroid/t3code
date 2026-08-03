# Update delivery — CI builds, relay pushes, the app offers a restart

**Status:** design, approved 2026-08-03
**Closes:** #41 (relaunch race), #47 (stale-artifact hazard — the contract half)

## Problem

A merge to `main` reaches an installed fork desktop app only by accident today. The local
watcher (`scripts/t3x/auto-build-desktop.sh`) rebuilds on a 12-hour cadence, swaps the bundle
silently, and relaunches through a race that left the app dark for 103 minutes on 2026-08-02
(#41). There is no moment at which a human is told "a new build exists, restart when you're
ready".

We want: merge to `main` → CI builds → the app says so → one click restarts into the new build.

## Decisions taken

| Decision            | Choice                                                            | Why                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who builds          | **GitHub Actions**, not the user's machine                        | Standard macOS and Windows runners are free with unlimited minutes on public repos; this fork is public. No local CPU cost, no local toolchain drift.                                        |
| Signal transport    | **CI → fork-owned Worker → push to app**                          | Chosen over polling. Sub-second, and the Worker is ~150 lines.                                                                                                                               |
| Worker tenancy      | **One Worker, shared**                                            | The repo is public, so "`main` moved to `<sha>`" is public information. No subscriber identity, no tokens, no revocation. One secret in the whole system: the HMAC proving CI sent the ping. |
| Notification UI     | **Fork-owned toast, top-right**                                   | Explicit product call. Upstream's sidebar pill is silenced (see [Exactly one surface](#exactly-one-surface)).                                                                                |
| Download timing     | **Pre-staged in the background**; the click is an instant restart | The artifact already exists when the toast appears, so waiting to download only adds a progress bar.                                                                                         |
| Code signing        | **Unsigned**, fork-owned installer                                | $0. Costs us electron-updater's macOS path, which we replace with logic the fork already has.                                                                                                |
| Platforms (v1)      | macOS arm64, Windows x64                                          | Linux has no consumer; Windows arm64 is commented out upstream too.                                                                                                                          |
| **Update identity** | **Commit SHA, never the version string**                          | Forced by #47 — see below.                                                                                                                                                                   |

### Why identity is the SHA

Issue #47 records that the fork's package version does not bump between syncs (`0.0.31` →
`0.0.31`). Every version-keyed mechanism — electron-updater's `latest-mac.yml`, `FileVersion`
comparison, "is the installed build newer" — is therefore **silently wrong on this fork**: a
stale artifact reinstalls and reports success, indistinguishable from a real update.

So every artefact, manifest entry, comparison, and post-install verification in this design keys
on the 40-character commit SHA. The version string is display text and nothing else.

## Architecture

Five units, each independently testable.

```
  merge to main
       │
       ▼
 ┌──────────────────────────────┐
 │ A. t3x-release.yml           │  needs: t3x-ci green
 │    macos-latest  → dmg arm64 │
 │    windows-latest→ nsis x64  │
 └──────────────┬───────────────┘
                │ publishes
                ▼
      GitHub Release  (tag t3x-build-<shortsha>, prerelease)
        ├── T3Code-<sha>-arm64.dmg
        ├── T3Code-<sha>-x64.exe
        └── t3x-latest.json      ← SHA-keyed manifest + SHA256 per asset
                │
                │ B. notify step (HMAC-signed POST)
                ▼
 ┌──────────────────────────────┐
 │ C. Worker (fork-owned)       │  GET /latest  → JSON  (public)
 │    infra/t3x-update-relay/   │  GET /events  → SSE   (public)
 └──────────────┬───────────────┘
                │ push
                ▼
 ┌──────────────────────────────┐
 │ D. Desktop subscriber        │  compares payload.sha vs own build sha
 │    apps/desktop/src/t3x/     │  → downloads + stages in background
 │      updateDelivery/         │  → exposes state on the desktop bridge
 └──────────────┬───────────────┘
                │
                ▼
 ┌──────────────────────────────┐
 │ E. Toast (top-right)         │  "Update ready · Restart"
 │    apps/web/.../t3x/         │  click → install → app.relaunch()
 └──────────────────────────────┘
```

### A. Fork release workflow — `.github/workflows/t3x-release.yml` _(new, fork-owned)_

Upstream's `release.yml` cannot be reused: it runs on `blacksmith-12vcpu-macos-26` and
`blacksmith-32vcpu-windows-2025`, runners this fork has no access to. This mirrors the existing
`t3x-ci.yml` ↔ `ci.yml` relationship — same job, runners we can actually use.

- Trigger: `push` to `main`, gated on the `t3x-ci` verify job succeeding.
- Matrix: `macos-latest` (mac/dmg/arm64) and `windows-latest` (win/nsis/x64).
- Build: the existing `scripts/build-desktop-artifact.ts`, unsigned. `T3CODE_DESKTOP_SIGNED`
  already defaults to `false` and the script already clears `CSC_*` on that path — no fork edit.
- `resolveGitHubPublishConfig` reads `GITHUB_REPOSITORY`, which is `radroid/t3code` in a fork
  run, so Release publishing targets the fork with no configuration.
- Emits `t3x-latest.json` (our own SHA-keyed shape) alongside the artifacts. Upstream's
  version-keyed `latest-mac.yml` is **not** published — it would be actively misleading here.

**Windows flake mitigation (#47):** the desktop build task is serialised rather than run
alongside the web and server tasks, and process-spawn exit codes (`0xC0000142`, `0xC0000005`)
are retried up to 3 times and mapped to readable diagnostics. A 2-core `windows-latest` runner is
_more_ resource-constrained than the Windows 11 machine where the flake was first seen, so this
is required, not optional.

### B. Notify step

The final step of the release workflow POSTs to the Worker:

```json
{
  "sha": "<40-char>",
  "shortSha": "…",
  "builtAt": "<ISO8601>",
  "releaseTag": "t3x-build-…",
  "assets": [{ "platform": "darwin-arm64", "url": "…", "sha256": "…", "bytes": 123 }]
}
```

Signed `X-T3X-Signature: sha256=<hmac>` over the raw body. A workflow step rather than a GitHub
repo webhook, deliberately: it is versioned and reviewable in-repo, needs no webhook UI
configuration, and is naturally gated on the build having actually succeeded — a repo webhook
fires on push regardless of whether anything was built.

### C. Worker — `infra/t3x-update-relay/` _(new, fork-owned)_

A separate Worker, **not** a route in `infra/relay/`. `infra/relay/` is upstream-owned with zero
fork edits today; adding routes there would open a new front on the seam ledger, whose own
tripwire reads _"Before adding row 35, re-isolate something instead."_ It also has never
deployed on this fork — `deploy-relay.yml` has two cancelled runs from 2026-07-23 and the fork
holds none of its required secrets — so there is nothing to piggyback on.

- `POST /notify` — verify HMAC, reject replays older than 5 minutes, store as latest, broadcast.
- `GET /latest` — the current payload as JSON. Public, cacheable, doubles as the polling fallback.
- `GET /events` — SSE. Replays the current payload on connect, then streams changes.
- State + fan-out in a single Durable Object. One global channel; no per-subscriber state.
- No reader auth. Rate limiting only, since the payload is public information.

Deployed by its own workflow with one secret (`CLOUDFLARE_API_TOKEN`) and one shared
(`T3X_UPDATE_HMAC_SECRET`).

### D. Desktop subscriber — `apps/desktop/src/t3x/updateDelivery/` _(new, fork-owned)_

Lives in the **desktop main process**, because that is the thing being updated: it is always
local, even when the app is driving a remote environment, so a server-side owner would report
the wrong machine's state.

- **Knows its own SHA.** The release workflow injects `T3X_BUILD_SHA` at build time into a
  generated constant. An app with no injected SHA (any local dev build) disables the whole
  feature rather than guessing.
- Holds the SSE connection; falls back to polling `GET /latest` every 5 min if SSE fails; falls
  back again to the public GitHub Releases API if the Worker is unreachable. All three tiers work
  unauthenticated.
- On a payload whose `sha` differs from its own: download the matching asset to a staging dir,
  verify SHA256 against the manifest, mark ready. Discard and retry once on mismatch.
- Exposes `{ status, sha, shortSha, error }` over the desktop bridge.

**Install backends**, one per platform, behind one interface:

- _macOS:_ mount the dmg, replace `/Applications/<product>.app`, `xattr -dr com.apple.quarantine`,
  unmount. This is the logic `auto-build-desktop.sh --install` already implements and has been
  exercised for weeks — it is being moved and given a downloaded input, not invented.
- _Windows:_ run the NSIS installer with `/S`.

**Restart:** `app.relaunch()` then `app.quit()`, in the main process. This is the structural fix
for #41 — the relaunch is registered with Electron _before_ the quit, so there is no window in
which the old process is gone and nothing has started the new one. No external script relaunches
anything.

### E. Toast — `apps/web/src/components/t3x/UpdateToast.tsx` _(new, fork-owned)_

Mounted in `apps/web/src/routes/__root.tsx`, which already carries a seam-ledger row for
`NotificationCoordinator` / `ThreadOutboxDrain` / `PushSubscriptionManager`. One more mount
updates an existing row; it does not create a new one.

States: `hidden` → `staging` (quiet, no UI) → `ready` ("Update ready · Restart", dismissible) →
`restarting` → `failed` (message + log path).

Logic lives in `UpdateToast.logic.ts` with the component thin over it, following the existing
`ProviderUpdateLaunchNotification.logic.ts` pattern in this codebase.

## Exactly one surface

Upstream's `SidebarUpdatePill` is driven by `DesktopUpdates.ts` via electron-updater. Left alone,
fork builds could show two update surfaces disagreeing with each other — the "parallel paths"
hazard `SEAMS.md` warns about.

`DesktopUpdates.ts:235` already honours a `T3CODE_DISABLE_AUTO_UPDATE` setting and reports
`status: "disabled"`. Fork builds set it. Upstream's pill then never renders, the fork's toast is
the only update surface, and **this costs zero upstream edits** — it is configuration, not a seam.

## Failure handling

| Failure                     | Behaviour                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CI build fails              | No Release, no notify, no toast. The app keeps running the build it has.                                                            |
| Worker down                 | SSE reconnects with backoff → polling `/latest` → public Releases API. Never blocks the app.                                        |
| Download corrupt            | SHA256 mismatch against the manifest → discard, retry once, then surface `failed`.                                                  |
| Artifact not actually newer | The installer refuses any artifact whose SHA equals the running SHA (#47's stale-installer hazard).                                 |
| Install fails               | Toast shows `failed` with the log path. Never silent — the other half of #41.                                                       |
| Relaunch fails              | `app.relaunch()` is registered before `app.quit()`, so Electron owns the restart; there is no external relauncher to lose the race. |
| No injected build SHA       | Feature disables itself. A dev build never claims to be out of date.                                                                |

## Testing

- **Worker:** HMAC accept/reject, replay rejection, `/latest` before any notify, SSE replay-on-connect, broadcast to multiple subscribers.
- **Subscriber:** SHA comparison (newer / identical / unknown), the three-tier fallback chain, checksum mismatch, staging-dir cleanup.
- **Installer:** fixture-driven, covering #47's three cases explicitly — stale artifact, equal-SHA artifact, fresh artifact — asserting post-install verification is by SHA, never version string.
- **Toast logic:** every state transition, dismissal, and the failure message.
- **Release workflow:** `scripts/mock-update-server.ts` already exists upstream and is reused for install-path tests rather than hitting GitHub.
- **Windows exit codes:** unit tests mapping `0xC0000142` / `0xC0000005` to readable diagnostics (#47's third requested test).

## Seam budget

Target: **zero new rows** in `docs/t3x/SEAMS.md`.

Everything new lives in fork-owned files. Existing rows that gain lines: `apps/web/src/routes/__root.tsx`
(one mount) and, if the bridge needs new members, `apps/desktop/src/preload.ts`,
`apps/desktop/src/ipc/channels.ts`, `packages/contracts/src/ipc.ts` — all three already carry rows
from the notification work. Per the ledger's self-reference rule, those rows and the header totals
are updated in the same commit as the change.

## Out of scope for v1

Code signing and notarization; Linux and Windows arm64; mobile; any change to how upstream
releases are consumed; upstreaming any of this. `scripts/t3x/auto-build-desktop.sh` remains for
local dev builds but is no longer the delivery path — its `--relaunch` mode should be removed
once this lands, closing #41 at the source.
