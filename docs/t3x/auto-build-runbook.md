# t3x — auto-build & install the desktop app

Keeps the installed macOS desktop app current as the fork changes: rebuild the
arm64 `.dmg` when `HEAD` moves, and optionally install it — no manual
dmg-dragging.

Everything lives in `scripts/t3x/`. **Zero upstream seams** — this feature adds
no edits to any upstream-owned file, so it can never conflict during the daily
rebase. The build itself is the existing `pnpm dist:desktop:dmg:arm64`;
`scripts/build-desktop-artifact.ts` is never modified.

## TL;DR

```bash
# one-shot: build a .dmg if HEAD changed since the last build
scripts/t3x/auto-build-desktop.sh

# see exactly what an install would do, without touching /Applications
scripts/t3x/auto-build-desktop.sh --install --dry-run

# build + actually install (replaces the app in /Applications)
scripts/t3x/auto-build-desktop.sh --install

# poll HEAD every 60s and rebuild+install on every new commit
scripts/t3x/auto-build-desktop.sh --watch --install
```

## ⚠️ Read this before using `--install`

**Which app gets replaced?** The installer takes the `.app` found inside the
freshly built `.dmg` and replaces `/Applications/<that same name>.app`.

A plain local `dist:desktop:dmg:arm64` build is the **stable** channel, so it
produces **`T3 Code.app`**. If the app you actually use day-to-day is
`T3 Code (Alpha).app` or `T3 Code (Nightly).app`, then `--install` will create a
**new, third** app in `/Applications` and your Alpha/Nightly install will be
untouched — i.e. it will look like "nothing updated."

Check what you have:

```bash
ls -d "/Applications/"*T3*
```

If the names don't match what the build produces, decide deliberately:

- **Switch to running the stable `T3 Code.app`** that this pipeline builds
  (recommended — simplest), or
- Point the installer somewhere else per-run:
  `T3X_AUTOBUILD_APPLICATIONS_DIR=/some/dir scripts/t3x/auto-build-desktop.sh --install`, or
- Build the channel you actually run and adjust accordingly.

**This also assumes you run the _installed_ app, not `pnpm start:desktop`.**
Those are different processes; auto-install updates the installed one only.

**Gatekeeper.** Local builds are unsigned (`T3CODE_DESKTOP_SIGNED` defaults to
`false`), so macOS quarantines them. The installer runs
`xattr -dr com.apple.quarantine` on the installed app so it launches without a
Gatekeeper block. Nothing here is code-signed or notarized.

## How the trigger works

Rebuilds are keyed on a **new commit SHA**, not on file saves — a `.dmg` build
takes minutes, so watching raw file writes would rebuild continuously mid-edit.

The last successfully built SHA is recorded in
`~/.t3/userdata/t3x-autobuild-last-sha`. If `git rev-parse HEAD` matches it, the
script logs "no change" and exits `3`. Use `--force` to rebuild anyway.

Because the marker only advances on a **successful** build, a failed build is
retried on the next poll rather than being silently skipped.

## Flags

| Flag              | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `--install`       | After a successful build, install the `.app` into `/Applications`.  |
| `--relaunch`      | With `--install`, `open` the app afterwards.                        |
| `--watch`         | Poll `HEAD` forever; build (and install, if asked) on each new SHA. |
| `--interval N`    | Poll interval in seconds for `--watch` (default `60`).              |
| `--dry-run`       | Log every step; never build, never touch `/Applications`.           |
| `--force`         | Build even if `HEAD` is unchanged.                                  |
| `--print-launchd` | Emit a ready-to-use LaunchAgent plist on stdout.                    |

## Where things land

| What                  | Path                                                      |
| --------------------- | --------------------------------------------------------- |
| Built `.dmg`          | `<repo>/release/` (override: `T3CODE_DESKTOP_OUTPUT_DIR`) |
| Last-built SHA marker | `~/.t3/userdata/t3x-autobuild-last-sha`                   |
| Status JSON           | `~/.t3/userdata/t3x-autobuild-status.json`                |
| Log                   | `~/.t3/userdata/logs/t3x-autobuild.log`                   |

Status JSON looks like:

```json
{
  "result": "built",
  "sha": "…",
  "dmgPath": "…/release/T3 Code-…arm64.dmg",
  "builtAt": "2026-07-24T01:12:33-0700",
  "installed": false,
  "detail": "ok"
}
```

Env overrides: `T3X_AUTOBUILD_STATE_DIR`, `T3CODE_DESKTOP_OUTPUT_DIR`,
`T3X_AUTOBUILD_APPLICATIONS_DIR`, `T3X_AUTOBUILD_KEEP_DMGS` (default `3`).

## Running it hands-off

### Option 1 — LaunchAgent (starts at login)

```bash
scripts/t3x/auto-build-desktop.sh --print-launchd --install --interval 120 \
  > ~/Library/LaunchAgents/dev.t3x.autobuild.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/dev.t3x.autobuild.plist
```

Stop / remove it:

```bash
launchctl bootout "gui/$UID/dev.t3x.autobuild"
rm ~/Library/LaunchAgents/dev.t3x.autobuild.plist
```

`--print-launchd` substitutes the real repo path, script path, interval and log
path, and mirrors `--install` into the emitted `ProgramArguments`.

### Option 2 — git hook

`scripts/t3x/hooks/post-merge` fires a detached build after `git pull`/`git merge`.
It is **not** installed automatically:

```bash
git config core.hooksPath scripts/t3x/hooks
# or, for just this hook:
ln -sf ../../scripts/t3x/hooks/post-merge .git/hooks/post-merge
```

### Option 3 — run the watcher in a terminal

```bash
scripts/t3x/auto-build-desktop.sh --watch --install --interval 120
```

In `--watch` mode the script re-execs itself under `caffeinate -s` so the Mac
won't sleep mid-build. A failed build logs and the loop keeps polling — it never
crashes out.

## Caveats & risks

- **Builds take minutes.** Back-to-back commits don't queue up: each poll builds
  whatever `HEAD` is _now_, so rapid commits collapse to one build of the latest.
- **`--install` is disruptive.** It quits the running app (`osascript quit`),
  `rm -rf`s the target in `/Applications`, and copies the new one in. Fine
  overnight; annoying mid-session. There is no "skip if app is foregrounded"
  check yet.
- **Unsigned.** Quarantine-stripping is required on every install. If macOS
  tightens Gatekeeper this may stop working.
- **Disk.** Old `.dmg`s are pruned to the newest `T3X_AUTOBUILD_KEEP_DMGS` (3)
  after each successful build.
- **First build after a lockfile change** runs `pnpm install --frozen-lockfile`,
  which adds time.

## Out of scope (the "real" auto-update path)

The fully hands-off alternative is to **code-sign + notarize** the build, publish
the `.dmg` to the fork's GitHub Releases, and let the app's built-in
`electron-updater` pull it (`T3CODE_DESKTOP_UPDATE_REPOSITORY=radroid/t3code`).
That removes the local watcher entirely but needs an Apple Developer signing
cert, notarization, and a macOS CI publish workflow. Deferred until the local
pipeline proves insufficient.
