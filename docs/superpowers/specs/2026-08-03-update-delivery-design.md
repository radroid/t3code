# Update delivery — CI builds, relay pushes, the app offers a restart

**Status:** design, approved 2026-08-03; revised after review the same day (see [Provenance](#provenance))
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

**Trigger — `workflow_run`, not `push`.** `t3x-ci` is a separate workflow, and `needs:` cannot
cross workflows. The only mechanism is:

```yaml
on:
  workflow_run:
    workflows: ["t3x fork CI"]
    types: [completed]
    branches: [main]
```

gated on `github.event.workflow_run.conclusion == 'success'`. **`actions/checkout` must pin
`ref: ${{ github.event.workflow_run.head_sha }}`** — under `workflow_run`, `github.sha` is the
default-branch tip, not the commit that was tested. For a design whose entire identity is the
commit, checking out the wrong one is silent and fatal.

Also required at the workflow level: `permissions: contents: write` (upstream's `release.yml` sets
`contents: read` and publishes with a GitHub App token the fork does not have), and a
`concurrency` group so two rapid merges cannot race.

**Matrix:** `macos-latest` (mac/dmg/arm64) and `windows-latest` (win/nsis/x64).

**Steps, in order:**

1. `actions/checkout` with `ref: <head_sha>` and a sparse-checkout excluding `.repos/` — it is
   tracked, 12,961 files, 126 MB, and upstream excludes it from every job.
2. `voidzero-dev/setup-vp@v1`, then `ensure:electron` (upstream runs this in `preflight`, and the
   fork's own `t3x-weekly-verify.yml` runs it too).
3. **Rust toolchain** — `dtolnay/rust-toolchain@stable` with the explicit target, plus
   `Swatinem/rust-cache`. This is not optional: `stageResourceMonitor` is called with no platform
   or flag guard (`build-desktop-artifact.ts:1840`), shells `cargo build --locked --release`, and
   hard-fails when the binary is missing. `native/resource-monitor` is `edition = "2024"` (Rust
   ≥1.85) with `lto = "thin"` and `codegen-units = 1` — a deliberately slow profile. The
   uncommitted cargo-PATH fix in `auto-build-desktop.sh` exists precisely because this dependency
   was discovered the hard way.
4. Windows only: Spectre-mitigated MSVC libs. Upstream installs these unconditionally, separate
   from the signing block; the staged `vp install --prod` still runs native lifecycle scripts.
5. `vp run build:desktop --concurrency-limit 1` as its own step — the #47 mitigation, applied at
   the workflow level so no upstream file is edited.
6. `scripts/build-desktop-artifact.ts --skip-build --build-version <semver>`, with
   **`GITHUB_REPOSITORY: ""`** (see [Exactly one surface](#exactly-one-surface) — this is
   load-bearing, not hygiene) and `T3CODE_DESKTOP_SIGNED` left at its `false` default.
7. Collect: rename artifacts to SHA-keyed filenames, compute SHA256 per asset, generate
   `t3x-latest.json`.
8. Publish with `softprops/action-gh-release` using the default `GITHUB_TOKEN`.
9. Notify the Worker.

**The build script does not publish.** `resolveGitHubPublishConfig`'s result is written into
`stagePackageJson.build.publish` and electron-builder is then invoked with `--publish never`
(`:2035`). Upload is a separate workflow step, exactly as upstream does it. Earlier drafts of this
design claimed publishing came for free; it does not.

**Version must be semver, so identity is carried separately.** `--build-version` becomes
electron-builder's `version` field and a 40-char SHA is not valid semver. Use
`0.0.31-t3x.<shortsha>`; `resolveDesktopUpdateChannel` only special-cases `-nightly.<d>.<d>`
(`:1478`), so this stays on the `latest` channel and the product name is unchanged.

**Identity reuses what already exists.** The build script already runs
`git rev-parse --short=12 HEAD` (`:523`) and writes `t3codeCommitHash` into the staged
package.json (`:1918`); `DesktopAppIdentity` reads it back and normalises to 12 chars
(`DesktopAppIdentity.ts:14,84`). So the app **already knows its own commit** — there is no need to
inject `T3X_BUILD_SHA`, and this design does not. Comparison is on the 12-char short hash; the
manifest carries the full SHA for display and traceability only.

**Not copied from upstream's `release.yml`**, each of which fails outright here: the
`relay_public_config` job (the inherited `production` environment has zero secrets and zero
variables, and the step explicitly `exit 1`s on missing values); the relay tracing-config artifact
download (no such artifact without that job); ImageMagick (Linux-only; macOS uses built-in
`sips`/`iconutil`); and the Azure/Apple signing blocks.

**Cloud features are off in fork builds, by omission and verified.** Every consumer of the relay
and Clerk config defaults to an empty string rather than throwing
(`apps/web/vite.config.ts:31-32`, `apps/server/vite.config.ts:48-51`,
`apps/desktop/vite.config.ts:8-10`), and the web entry renders without `ClerkProvider` when the
key is absent (`apps/web/src/main.tsx:39`). `T3CODE_CLERK_PUBLISHABLE_KEY` is only _required_ for
signed macOS passkey builds (`build-desktop-artifact.ts:1862-1868`, gated on `options.signed`),
which the unsigned path never reaches. The result is a working local-only app with no T3 Connect,
no Clerk sign-in, and no relay — the same thing the fork's local dmgs have shipped for weeks. This
is a deliberate, accepted property of v1.

**Timeout:** `timeout-minutes: 90`. Upstream's 30 is calibrated for 12–32 vCPU blacksmith runners.
A warm local build measures ~1m48s, but a cold `macos-latest` (3 vCPU, 7 GB) with no pnpm store,
no cargo target dir, and an Electron download is realistically 20–40 min; Windows NSIS is 30–60
min given #47's ~18 min on a warm desktop. The 6-hour default is not the risk — a copied 30-minute
cap is.

**Disk:** standard runners have ~14 GB. `--target dmg` also emits a `zip`
(`build-desktop-artifact.ts:1568`) — locally 237 MB + 234 MB — on top of an unpacked ~1 GB
`dist/mac-arm64`, a second `vp install --prod` tree, and the Electron download. The workflow frees
disk before building and suppresses the mac `zip` target, which nothing in this design consumes.

**Retention:** one prerelease per merge is unbounded growth at ~470 MB per macOS build. The
workflow prunes `t3x-build-*` prereleases to the most recent 10.

**Flake retries:** the Windows `0xC0000142` / `0xC0000005` family (#47) _and_ macOS `hdiutil`
"Resource busy", both retried up to 3 times with readable diagnostics.

**Windows flake mitigation (#47):** the desktop build task is serialised rather than run
alongside the web and server tasks, and process-spawn exit codes (`0xC0000142`, `0xC0000005`)
are retried up to 3 times and mapped to readable diagnostics. `windows-latest` is 4 vCPU / 16 GB
— comparable to, not weaker than, the Windows 11 machine where the flake was first seen — so
this is insurance against a known-intermittent failure rather than a response to a tighter
runner. It is still worth doing: #47 records that a failed build leaves no artifact, and any
consumer picking "the newest installer" then silently reinstalls a stale one.

> Note: `t3x-ci.yml` currently describes `ubuntu-latest` as "2-core" in three comments. Public-repo
> standard runners were doubled to 4 vCPU / 16 GB in Dec 2023, so those comments are stale. Not
> fixed here — it is unrelated to this change — but the timeout values they justify should be
> re-derived from a real measurement rather than from the stated core count.

### B. Notify step

The final step of the release workflow POSTs to the Worker:

```json
{
  "sha": "<40-char, display and traceability only>",
  "shortSha": "<12-char, the comparison key>",
  "version": "0.0.31-t3x.<shortsha>",
  "builtAt": "<ISO8601>",
  "releaseTag": "t3x-build-<shortsha>",
  "assets": [{ "platform": "darwin-arm64", "url": "…", "sha256": "…", "bytes": 123 }]
}
```

`shortSha` is 12 characters to match `t3codeCommitHash`, which is what the app can actually read
about itself. Comparing anything else means comparing against a value the app does not have.

Signed `X-T3X-Signature: sha256=<hmac>` over `X-T3X-Timestamp` + the raw body. A workflow step
rather than a GitHub repo webhook, deliberately: it is versioned and reviewable in-repo, needs no
webhook UI configuration, and is naturally gated on the build having actually succeeded — a repo
webhook fires on push regardless of whether anything was built.

**Notify is a third job, not a step in the matrix.** The payload spans both platforms, but the
build is a two-job matrix — so notifying from within it either fires twice (the second overwriting
the first, leaving half the users with nothing) or publishes a manifest before the other
platform's asset exists (so those clients 404). The workflow therefore has a `publish` job with
`needs: [build]` that assembles `t3x-latest.json` from both legs, uploads it, and only then
notifies.

**If either leg fails, there is no notify at all.** A half-platform release is not a release, and
the failure mode of publishing one anyway is a Windows user whose toast points at an asset that
does not exist.

### C. Worker — `infra/t3x-update-relay/` _(new, fork-owned)_

A separate Worker, **not** a route in `infra/relay/`. `infra/relay/` is upstream-owned with zero
fork edits today; adding routes there would open a new front on the seam ledger, whose own
tripwire reads _"Before adding row 35, re-isolate something instead."_ It also has never
deployed on this fork: `deploy-relay.yml` has exactly one run in fork history (cancelled,
2026-07-23), is now `disabled_manually`, and needs six secrets plus twelve variables the fork
does not have. There is nothing to piggyback on.

Every inherited upstream workflow is `disabled_manually` on this fork, `release.yml` included —
which is why a fork-owned release workflow is required rather than merely convenient.

- `POST /notify` — verify HMAC over `X-T3X-Timestamp` + raw body, reject a timestamp skewed more
  than 5 minutes, reject non-monotonic payloads, store as latest, broadcast. The timestamp is an
  explicit header, **not** `builtAt`: uploading ~470 MB routinely pushes notify well past 5
  minutes after the build finished.
- `GET /latest` — the current payload as JSON, `Cache-Control: no-store`. It is the fallback tier;
  edge-caching it would serve stale JSON and defeat the push tier it is backstopping.
- `GET /events` — SSE. Replays the current payload on connect, then streams changes. Emits a
  `: ping` comment every 20s and **closes the stream after 15 minutes**, expecting the client to
  reconnect.
- State + fan-out in a single Durable Object. One global channel; no per-subscriber state.
- No reader auth. Rate limiting only, since the payload is public information.

**Monotonicity is a first-class rule, not an optimisation.** The client's only specified check is
"differs from my SHA", which is symmetric — so an out-of-order notify downgrades every app. Two
things make out-of-order likely here: a matrix where the Windows leg can finish after a later
run's macOS leg, and a `main` that is **force-pushed** by the sync playbook, so a released commit
may not be an ancestor of `main` and ancestry cannot order anything. The manifest therefore
carries `buildNumber` (the release workflow's `github.run_number`), and both the Worker and the
client reject any payload whose `buildNumber` is `<=` the one they hold. Replay protection is the
timestamp; **ordering is `buildNumber`**, and they are not the same mechanism.

**SSE cannot hibernate.** Hibernation is WebSocket-only, so every connected app pins the Durable
Object in memory and DO duration is metered on wall time. The 15-minute stream cap above is what
keeps that bounded; the client's reconnect is not a fallback path but the normal cycle. The
$0 premise otherwise holds — SQLite-backed DOs are on the Workers free plan — but the wrangler
migration **must** use `new_sqlite_classes`. The widely-copy-pasted `new_classes` form is
KV-backed and will not deploy on a free account.

Deployed by its own workflow with one secret (`CLOUDFLARE_API_TOKEN`) and one shared
(`T3X_UPDATE_HMAC_SECRET`).

### D. Desktop subscriber — `apps/desktop/src/t3x/updateDelivery/` _(new, fork-owned)_

Lives in the **desktop main process**, because that is the thing being updated: it is always
local, even when the app is driving a remote environment, so a server-side owner would report
the wrong machine's state.

- **Knows its own commit already.** No injection is added. `DesktopAppIdentity` exposes
  `t3codeCommitHash`, written into the staged package.json by the build script (`:1918`) and read
  back normalised to 12 chars (`DesktopAppIdentity.ts:14,84`). An app with no commit hash — any
  local dev build — disables the feature rather than guessing.
  `resolveGitCommitHash` returns the literal string `"unknown"` on any git failure
  (`build-desktop-artifact.ts:536-543`), so **`"unknown"` is treated as absent, not as a hash** —
  otherwise a build with a broken git context updates on every payload forever. Comparison is a
  normalised prefix match against the 12-char value.
- Holds the SSE connection; falls back to polling `GET /latest` every 5 min if SSE fails; falls
  back again to the public GitHub Releases API if the Worker is unreachable. All three tiers work
  unauthenticated and decode the same manifest type; the Releases-API tier is a two-step (list
  releases, then fetch the `t3x-latest.json` asset).
- **A floor poll of `/latest` runs every 15 minutes regardless of SSE health.** This is the single
  most important reliability rule in the design. A reconnect-on-error ladder only fires on an
  _observed_ failure, and the failure that actually happens here is the unobserved one: after
  laptop sleep, or across NAT or Tailscale, a TCP connection comes back with the socket open, no
  error event, and no bytes ever again. That is silent, unbounded, and exactly the shape of the
  103-minute #41 outage this design exists to close.
- Backing that up: a client watchdog at 50s (2.5× the server's 20s heartbeat) that **hard-destroys
  the socket** and reconnects when no bytes arrive — not a reconnect-on-error, which never fires —
  plus unconditional reconciliation on `powerMonitor` `resume` / `unlock-screen` and on
  network-online.
- **There is no `EventSource` in the Electron main process.** Node's global is Stability-1 behind
  `--experimental-eventsource`, and packaged Electron cannot take Node CLI flags (the `nodeOptions`
  fuse). Use a hand-rolled `fetch` + stream parser to avoid a new runtime dependency; if a package
  is used instead it must be added to `apps/desktop/package.json` so it flows through
  `resolveDesktopRuntimeDependencies` (`build-desktop-artifact.ts:1433`) into the staged prod
  install — otherwise dev works and the packaged app throws `ERR_MODULE_NOT_FOUND`.
- Exposes `{ status, shortSha, buildNumber, error }` over the desktop bridge.

**Staging goes all the way to swap-ready.** "The click is an instant restart" is only true if
nothing expensive remains. Downloading and checksumming is not enough: on macOS the costly part is
`hdiutil attach` + `cp -R` of a ~470 MB bundle + recursive `xattr -dr` over tens of thousands of
files. So staging performs the whole thing in the background — attach, copy to `<target>.t3x-new`
**beside the final target on the same volume**, strip quarantine, detach — and the click is only
`rm -rf target && mv staged target && relaunch`.

Ordering is inherited from `auto-build-desktop.sh`, which documents both traps: BSD
`cp -R src.app dst.app` copies _into_ `dst.app` when it already exists, nesting the new build
inside the old one and exiting 0; and deleting the target before the copy leaves nothing installed
if the copy fails.

Concurrency and crash-safety rules, all of which the earlier draft left open:

- Download to `<name>.part`, fsync, rename only after the checksum passes. A truncated file that
  survives a crash must never present as `ready`.
- Staging is keyed by target SHA. A newer payload aborts the in-flight fetch and deletes the
  partial. Never two concurrent downloads; never a `ready` state pointing at an older SHA.
- Staging lives under `app.getPath("userData")`, not `temp` — a temp sweep mid-stage would produce
  a `ready` state whose artifact has vanished.
- Sweep on startup: keep at most one staged artifact, delete anything not matching the current
  target SHA. At ~470 MB per artifact on a merge-to-main cadence this is not optional; the existing
  script keeps `T3X_AUTOBUILD_KEEP_DMGS=3` for the same reason.
- Check free disk before downloading and surface `failed` rather than filling the disk.
- **Install is single-flight in the main process.** `__root.tsx` renders per window, so two windows
  mean two toasts and two possible Restart clicks racing on one target. Copy the existing
  `updateInstallInFlightRef` pattern (`DesktopUpdates.ts:260`); the second click is a no-op.

### macOS install

- **Resolve the target from `app.getPath("exe")`**, walking up to the `.app` — never hardcode
  `/Applications`. Real cases: `~/Applications`, a second copy, a root-owned `/Applications` under
  MDM, a read-only volume. There is no privilege-escalation story for an unsigned app and there
  must not be one; pre-flight `fs.access(W_OK)` on the bundle's parent and surface `failed` with
  the staged path and "replace manually" when it fails.
- **Refuse any path containing `/AppTranslocation/`.** This is the sharpest trap in the design.
  `DesktopLifecycle.relaunch` re-execs `process.execPath` (`DesktopLifecycle.ts:158`); if the
  running app was ever launched while quarantined — the first run after a manual dmg drag is
  exactly this — `execPath` points into a read-only randomised snapshot. The installer would write
  `/Applications`, the relaunch would re-exec the _translocated old bundle_, and the app would come
  back on the old commit while post-install verification passed, because it verified the wrong
  process. Silent success, wrong result. Surface `failed` with "move the app to /Applications once".
- **Never compute the product name.** `resolveDesktopProductName` returns
  `desktopPackageJson.productName`, which is `"T3 Code (Alpha)"` on this fork — and the script
  records what happens when this is guessed instead of read: it _"always claimed `T3 Code.app` — an
  app that does not exist — while a real install replaced `T3 Code (Alpha).app`"_. Read the `.app`
  name out of the mounted dmg and cross-check it against the running bundle; refuse on mismatch,
  because installing a differently-named bundle creates a second app and leaves the running one
  untouched.
- Download the dmg with the app's own HTTP client — `fetch` does not set `com.apple.quarantine`,
  unlike LaunchServices-aware downloaders — and strip it anyway before `hdiutil attach`. Mount
  under `$TMPDIR` with an explicit `-mountpoint`, not `/Volumes`: mounting under `/Volumes` from
  inside the app raises the "access files on a removable volume" TCC prompt, which a background
  staging step cannot answer.

### Windows install

The macOS single-restart model does not transfer, and this needs stating plainly rather than being
discovered.

- The installer needs the app's files, so the app **cannot** wait for it. The only working sequence
  is: spawn the installer **detached**, quit immediately, let the installer relaunch the app. A
  silent NSIS install that hits a running app is the documented cause of installers that hang
  forever with no UI.
- Argv is `/S --force-run` (electron-updater's `NsisUpdater` also passes `--updated`). `/S` alone
  does not relaunch.
- Pin `oneClick: true, perMachine: false` explicitly in the build config rather than inheriting
  electron-builder's defaults, which an upstream sync could flip. `/S` against a per-machine
  install fails silently on privileges, and `/S` + `/allusers` is ignored.
- Unsigned NSIS plus Mark-of-the-Web is SmartScreen's exact target, and launched programmatically
  it may not offer the "Run anyway" affordance a double-click does. Download through the app's HTTP
  client and define what the toast says when the launch is blocked anyway.
- Post-install verification cannot be done in-process (the process is gone). Verify on next
  startup: compare `t3codeCommitHash` against the recorded target and surface `failed` if it did
  not move.

### Restart

**Reuse `DesktopLifecycle.relaunch`** (`DesktopLifecycle.ts:144-170`), which already does
`requestDesktopShutdownAndWait()` → `app.relaunch({execPath, args})` → `app.exit(0)`. The earlier
draft's `app.relaunch()` + `app.quit()` is a _different_ path that re-enters `handleBeforeQuit`.

Two corrections to that existing path, both required:

- **The shutdown wait is unbounded.** `requestDesktopShutdownAndWait` awaits a bare `Deferred`
  (`DesktopShutdown.ts:30`), which resolves only after every backend stops, and
  `DesktopBackendManager.closeRun` takes a no-timeout branch when given no options
  (`DesktopBackendManager.ts:355-359`). A wedged PTY drain, an SSH tunnel, or a `wsl.exe` backend
  that will not return means the relaunch never fires and the toast sits on `restarting` forever —
  **#41 arrived at through a different door**. Wrap the wait in `Effect.timeout(10s)`, then
  `app.exit(0)` unconditionally with the relaunch already armed.
- **`execPath` must be recomputed from the install target**, never taken from `process.execPath`
  (see the translocation trap above).
- Arm the relaunch immediately before the forced exit, never before the graceful shutdown, and
  never leave it armed on a failure path — `app.relaunch()` registers intent for the _next_ quit,
  so a prevented quit leaves the app alive and the user's next Cmd-Q silently resurrects it.

Full ordering: copy → checksum → `rm -rf target` → `mv` → arm relaunch → `exit(0)` → verify
`t3codeCommitHash` on next startup.

**A consequence of shipping unsigned that must be written down:** electron-builder ad-hoc signs
macOS bundles, and macOS TCC authorises on code-signing identity, which changes with every build.
So **every accepted update resets this app's privacy grants** — Automation/AppleEvents, Files &
Folders, Screen Recording, Accessibility, notifications, and any Keychain ACLs behind the bundled
passkey support. At merge-to-main cadence that is per-update, not occasional. This does not reopen
the unsigned decision, but it is a real recurring cost of it and the toast should say so on first
update.

### E. Toast — `apps/web/src/components/t3x/UpdateToast.tsx` _(new, fork-owned)_

Mounted in `apps/web/src/routes/__root.tsx`, which already carries a seam-ledger row for
`NotificationCoordinator` / `ThreadOutboxDrain` / `PushSubscriptionManager`. One more mount
updates an existing row; it does not create a new one.

States: `hidden` → `staging` (quiet, no UI) → `ready` ("Update ready · Restart", dismissible) →
`restarting` → `failed` (message + log path).

Logic lives in `UpdateToast.logic.ts` with the component thin over it, following the existing
`ProviderUpdateLaunchNotification.logic.ts` pattern in this codebase.

**Use the existing `toastManager`, not a bespoke overlay.** It already renders at `top-right` by
default and is persistent unless `dismissAfterVisibleMs` is set (`ui/toast.tsx:461,531`) — which is
exactly the required behaviour. A parallel notification surface would be the "parallel paths"
hazard in miniature.

This also matters because the topology is not "upstream's pill vs. our toast" as earlier drafts
assumed. There is a **third** surface: `showDesktopUpdateDownloadedToast`
(`apps/web/src/components/desktopUpdate.toast.tsx`), fired from `Sidebar.tsx:136` and
`SidebarUpdatePill.tsx:17` into the _same_ `toastManager` at the _same_ `top-right` position. The
`GITHUB_REPOSITORY: ""` mechanism silences it along with the pill, because all of it hangs off the
same `enabled` flag — which is a further argument for that mechanism over anything that only
targets the pill.

## Exactly one surface

Upstream's `SidebarUpdatePill` is driven by `DesktopUpdates.ts` via electron-updater. Left alone,
fork builds could show two update surfaces disagreeing with each other — the "parallel paths"
hazard `SEAMS.md` warns about.

The mechanism is **not** `T3CODE_DISABLE_AUTO_UPDATE`. That is read through Effect `Config`
against the process environment (`DesktopConfig.ts:52`), and `apps/desktop/src` has no dotenv or
settings-file loader, so a `.app` launched from Finder has no way to receive it. There is no
zero-edit path to setting it.

The actual mechanism is to **not configure a feed at all**:

- `getAutoUpdateDisabledReason` checks `hasUpdateFeedConfig` **first**, before every other
  condition (`DesktopUpdates.ts:228-230`), returning _"Automatic updates are not available because
  no update feed is configured."_ `hasUpdateFeedConfig` is derived from the packaged
  `app-update.yml` (`:298`).
- `createBuildConfig` only sets `buildConfig.publish` when `resolveGitHubPublishConfig` returns
  something — and its only fallback, a `generic` provider, is gated on `mockUpdates`, which
  defaults to `false` (`build-desktop-artifact.ts:1554-1564`, `:1036`).
- `resolveGitHubPublishConfig` returns `undefined` for an empty repository string (`:1456-1463`).

So the release workflow runs the artifact step with `GITHUB_REPOSITORY: ""` and leaves
`T3CODE_DESKTOP_MOCK_UPDATES` unset. No `publish` config is written, no `app-update.yml` is
packaged, and upstream's updater disables itself. **Zero upstream edits, verified end to end.**

This matters more than it looks. Actions sets `GITHUB_REPOSITORY` automatically, so a naive
workflow would be the **first fork build ever to ship an `app-update.yml`** — pointing
electron-updater at `radroid/t3code` Releases and version-keyed against a version that never
bumps. The naive path doesn't just miss the mitigation; it actively creates the failure.

One residual case, accepted: `SidebarUpdatePill` has a second render branch that never consults
`enabled` — the "Intel build on Apple Silicon" alert (`SidebarUpdatePill.tsx:70,140`). It fires
only when `hostArch === "arm64" && appArch === "x64"`. v1 ships mac arm64 only, so it cannot
trigger; adding a mac x64 artifact later would make it a real second surface.

## Failure handling

| Failure                            | Behaviour                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI build fails                     | No Release, no notify, no toast. The app keeps running the build it has.                                                                           |
| One matrix leg fails               | No notify. A half-platform release is not published.                                                                                               |
| Worker down                        | SSE reconnect → 5-min `/latest` poll → public Releases API. Never blocks the app.                                                                  |
| **SSE silently dead** (sleep, NAT) | 50s watchdog hard-destroys the socket; 15-min floor poll catches it regardless. The failure that must never be silent.                             |
| Out-of-order notify                | Rejected by `buildNumber` monotonicity at both the Worker and the client. No downgrades.                                                           |
| Download corrupt                   | SHA256 mismatch → discard `.part`, retry once, then `failed`.                                                                                      |
| Crash mid-download                 | `.part` never renames, so it can never present as `ready`. Swept on next startup.                                                                  |
| Disk full                          | Free space checked before download; surfaces `failed` rather than filling the disk.                                                                |
| Artifact not actually newer        | Refused when the target hash equals the running `t3codeCommitHash` (#47's stale-installer hazard).                                                 |
| Commit hash is `"unknown"`         | Treated as absent → feature disabled. Never as a hash, which would update forever.                                                                 |
| App is translocated                | Refused with "move the app to /Applications once". Installing anyway would verify the wrong process and report success.                            |
| Bundle parent not writable         | Refused with the staged path and "replace manually". No privilege escalation for an unsigned app.                                                  |
| `.app` name mismatch               | Refused. Installing a differently-named bundle creates a second app and leaves the running one untouched.                                          |
| Two windows, two Restart clicks    | Install is single-flight in the main process; the second click is a no-op.                                                                         |
| Install fails                      | Toast shows `failed` with the log path. Never silent — the other half of #41.                                                                      |
| **Shutdown hangs**                 | `Effect.timeout(10s)` on the shutdown wait, then `app.exit(0)` with relaunch already armed. Without this the app is dark indefinitely — #41 again. |
| Quit is prevented                  | Relaunch is armed immediately before the forced exit only, so a cancelled quit cannot leave it armed to fire on the user's next Cmd-Q.             |
| Windows install blocked            | SmartScreen or a failed launch surfaces `failed`; verification happens on next startup by comparing `t3codeCommitHash` to the recorded target.     |

## Testing

- **Worker:** HMAC accept/reject, timestamp-skew rejection, **`buildNumber` monotonicity rejection**, `/latest` before any notify, SSE replay-on-connect, broadcast to multiple subscribers, the 15-minute stream cap.
- **Subscriber:** hash comparison (newer / identical / `"unknown"` / absent), the three-tier fallback chain, checksum mismatch, staging keyed by target SHA, newer-payload-aborts-in-flight, `.part` never presenting as ready, startup sweep.
- **The watchdog, explicitly:** a connection that stays open and delivers nothing must be detected and destroyed. This is the regression test for the failure class behind #41, and it is the one test that cannot be skipped.
- **Installer:** fixture-driven, covering #47's three cases explicitly — stale artifact, equal-hash artifact, fresh artifact — asserting post-install verification is by commit hash, never version string. Plus the refusal cases: translocated path, non-writable parent, `.app` name mismatch.
- **Restart:** shutdown-hangs → timeout fires → `exit(0)` still happens; relaunch is never left armed on a failure path.
- **Toast logic:** every state transition, dismissal, single-flight second click, and the failure message.
- **Release workflow:** `scripts/mock-update-server.ts` already exists upstream and is reused for install-path tests rather than hitting GitHub. Assert that the built app contains **no** `app-update.yml` — that is the machine-checkable form of "exactly one surface", and it is the claim most likely to regress silently on an upstream sync.
- **Windows exit codes:** unit tests mapping `0xC0000142` / `0xC0000005` to readable diagnostics (#47's third requested test).

## Seam budget

Target: **zero new rows** in `docs/t3x/SEAMS.md`.

Everything new lives in fork-owned files. Existing rows that gain lines:

| Existing row                       | What it gains               |
| ---------------------------------- | --------------------------- |
| `apps/web/src/routes/__root.tsx`   | one `<UpdateToast />` mount |
| `apps/desktop/src/preload.ts`      | update-state bridge members |
| `apps/desktop/src/ipc/channels.ts` | update channel constants    |
| `packages/contracts/src/ipc.ts`    | the update-state contract   |

All four already carry rows from the notification work. Per the ledger's self-reference rule,
those rows and the header totals are updated in the same commit as the change.

Two things that would have cost rows and do **not**, because a workflow-level equivalent exists:

- Silencing upstream's updater — done by withholding `GITHUB_REPOSITORY`, not by editing
  `DesktopUpdates.ts` or `main.ts`.
- Serialising the desktop build to mitigate #47 — `vp run build:desktop` is hardcoded with no
  concurrency flag (`build-desktop-artifact.ts:1796`), so editing it would cost a new row.
  Instead the workflow runs `vp run build:desktop --concurrency-limit 1` as its own step and then
  invokes the artifact script with `--skip-build` (`:1806-1826`).

## Out of scope for v1

Code signing and notarization; Linux and Windows arm64; mobile; any change to how upstream
releases are consumed; upstreaming any of this. `scripts/t3x/auto-build-desktop.sh` remains for
local dev builds but is no longer the delivery path — its `--relaunch` mode should be removed
once this lands, closing #41 at the source.

**Two known gaps shipped deliberately, both of which must be stated rather than discovered:**

1. **Windows artifacts have a non-functional WSL backend.** `stageWslNodePtyPrebuild` logs a
   warning and returns when no prebuild is supplied (`build-desktop-artifact.ts:1665-1670`) — it
   does not fail. Upstream produces that prebuild in a separate `build_wsl_node_pty` job on Linux
   and hands it to the Windows leg. v1 does not port that job, so a fork Windows build ships a WSL
   backend that cannot start, with nothing louder than a log line. Porting it is a third
   `ubuntu-latest` job plus an artifact handoff, and is the first follow-up if Windows/WSL matters.
2. **No cloud features.** No T3 Connect, no Clerk sign-in, no relay — see section A. Local-only use
   is unaffected, which is how the fork's dmgs have shipped for weeks.

## Provenance

This design was materially rewritten after review. The following claims in the first draft were
wrong, and each would have produced a silent failure rather than a loud one:

| First draft                                                      | Reality                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Fork builds set `T3CODE_DISABLE_AUTO_UPDATE` to silence the pill | It is a process env var with no delivery mechanism to a packaged app. Withhold `GITHUB_REPOSITORY` instead |
| `resolveGitHubPublishConfig` makes publishing work for free      | electron-builder runs `--publish never`; worse, that config **enables** upstream's updater                 |
| Trigger is `push` gated on `t3x-ci`                              | `needs:` cannot cross workflows; `workflow_run` + `head_sha` pinning, or the wrong commit is built         |
| Inject `T3X_BUILD_SHA`, identity is the 40-char SHA              | `t3codeCommitHash` already ships at 12 chars; a 40-char comparison never matches                           |
| The click is an instant restart                                  | Only if staging goes all the way to a swap-ready bundle                                                    |
| `app.relaunch()` + `app.quit()` fixes #41                        | `DesktopLifecycle.relaunch` exists; and the unbounded shutdown wait reintroduces #41                       |
| Two update surfaces to reconcile                                 | Three — `desktopUpdate.toast.tsx` fires into the same manager at the same position                         |
