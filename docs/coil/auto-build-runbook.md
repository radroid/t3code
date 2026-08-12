# t3x — auto-build & install the desktop app

Keeps the installed macOS desktop app current as the fork changes: rebuild the
arm64 `.dmg` when `HEAD` moves, and optionally install it — no manual
dmg-dragging.

Everything lives in `scripts/coil/`. **Zero upstream seams** — this feature adds
no edits to any upstream-owned file, so it can never conflict during the daily
rebase. The build itself is the existing `pnpm dist:desktop:dmg:arm64`;
`scripts/build-desktop-artifact.ts` is never modified.

## TL;DR

```bash
# one-shot: build a .dmg if HEAD changed since the last build
scripts/coil/auto-build-desktop.sh

# see exactly what an install would do, without touching /Applications
scripts/coil/auto-build-desktop.sh --install --dry-run

# build + actually install (replaces the app in /Applications)
scripts/coil/auto-build-desktop.sh --install

# poll HEAD every 12h (the default) and rebuild+install when it has moved
scripts/coil/auto-build-desktop.sh --watch --install
```

## ⚠️ Read this before using `--install`

**Which app gets replaced?** The installer takes the `.app` found inside the
freshly built `.dmg` and replaces `/Applications/<that same name>.app`.

The name is **not** a flag — it is derived from the version in
`apps/desktop/package.json` by `resolveDesktopProductName()`:

| Version                | Channel  | `.app` produced         |
| ---------------------- | -------- | ----------------------- |
| plain (e.g. `0.0.28`)  | `latest` | `T3 Coil (Alpha).app`   |
| `…-nightly.YYYYMMDD.N` | nightly  | `T3 Code (Nightly).app` |

The `latest` name comes from `"productName": "T3 Coil (Alpha)"` in
`apps/desktop/package.json` — **not** the `"T3 Code"` fallback, which only
applies if that field is ever removed upstream. So a default local build
replaces **`T3 Coil (Alpha).app`**, the app most fork users already run.

Don't trust the table — ask the script. `--dry-run` mounts the built `.dmg`
read-only and reports the **real** name, falling back to the prediction above
only when nothing has been built yet:

```bash
ls -d "/Applications/"*T3*                                    # what you have installed
scripts/coil/auto-build-desktop.sh --install --dry-run --force # what would be replaced
```

(`--force` is needed only because a dry run otherwise stops at "no change since
last build" before it reaches the install step.)

It prints one of:

```
DRY-RUN install: read 'T3 Coil (Alpha).app' from …/release/T3-Code-0.0.28-arm64.dmg
DRY-RUN: '/Applications/T3 Coil (Alpha).app' exists and WOULD be replaced
```

```
DRY-RUN WARNING: '/Applications/T3 Code.app' does NOT exist — a real --install
would create a NEW app and leave whatever you currently run untouched
```

That second form is the failure you care about: `--install` would create a
**new, separate** app and it would look like "nothing updated." Either switch to
running the app this build produces, or redirect the install with
`T3X_AUTOBUILD_APPLICATIONS_DIR=/some/dir`.

**This also assumes you run the _installed_ app, not `pnpm start:desktop`.**
Those are different processes; auto-install updates the installed one only.

**A nightly-versioned checkout targets a different app.** If a sync ever lands a
`-nightly.*` version, the same command starts replacing `T3 Code (Nightly).app`
instead. Re-run the check above after a big upstream sync.

**Gatekeeper.** Builds are not notarized (`T3CODE_DESKTOP_SIGNED` defaults to
`false`, and this script never turns it on), so macOS quarantines them. The
installer runs `xattr -dr com.apple.quarantine` on the installed app so it
launches without a Gatekeeper block.

**Code signing — and permission prompts (issue #70).** Builds _are_ code-signed
when this machine has the fork's signing identity, which the script picks up on
its own by exporting `CSC_NAME`. That is what stops macOS re-asking for Screen
Recording, Accessibility, Microphone, Files & Folders and Local Network on every
install: permission grants are keyed to the app's designated requirement, and an
unsigned build's requirement is its own `cdhash`, which changes every build. Set
the identity up once with `scripts/coil/setup-mac-signing.sh`; the script logs
`signing: NONE` and keeps building without it. Full runbook:
`docs/coil/mac-signing-runbook.md`.

> **The FIRST signed build re-prompts for everything, once.** The identity moves
> from a cdhash to a certificate, so the old grants no longer match and macOS asks
> again. That install looks exactly like the bug it fixes — judge the fix on the
> _second_ signed install, which should be silent.

Every build is verified before it is installed
(`scripts/coil/verify-mac-signature.ts`), and an install is refused if the
signature is missing when it should be present, or if the identity changed. A
build that would cost you a round of dialogs is not worth installing quietly.

## How the trigger works

Rebuilds are keyed on a **new commit SHA**, not on file saves — a `.dmg` build
takes minutes, so watching raw file writes would rebuild continuously mid-edit.

The last successfully built SHA is recorded in
`~/.t3/userdata/coil-autobuild-last-sha`. If `git rev-parse HEAD` matches it, the
script logs "no change" and exits `3`. Use `--force` to rebuild anyway.

Because the marker only advances on a **successful** build, a failed build is
retried on the next poll rather than being silently skipped.

### `--ref`: build a remote ref, not the local checkout

By default the watcher builds whatever `HEAD` the checkout it lives in happens to
be on — which couples "what's installed" to the state of that working tree. With
`--ref origin/main`, every run instead:

1. `git fetch origin main` (a failure — e.g. offline — is logged as
   `fetch-failed` in the status JSON and retried next tick; the marker never
   advances on failure).
2. Pins a **dedicated build worktree** (`T3X_AUTOBUILD_WORKTREE`, default
   `<repo>-build`) to that ref's SHA with a detached, `--force` checkout. The
   worktree is created on first use, and `pnpm install` runs automatically when
   its `node_modules` is missing.
3. Builds there. The main checkout is never read for builds, so local branches,
   uncommitted work, and agents operating in the repo can't change what gets
   installed.

The worktree never holds a branch (always detached), so no other worktree is
blocked from checking out `main`. The script itself still runs from the main
checkout — script changes take effect after that checkout is updated.

## Flags

| Flag              | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--install`       | After a successful build, install the `.app` into `/Applications`.                    |
| `--relaunch`      | With `--install`, `open` the app afterwards.                                          |
| `--watch`         | Poll `HEAD` forever; build (and install, if asked) on each new SHA.                   |
| `--interval N`    | Poll interval in seconds for `--watch` (default `43200`, i.e. 12h).                   |
| `--ref R`         | Build remote ref `R` (e.g. `origin/main`) in a dedicated worktree.                    |
| `--dry-run`       | Log every step; never build, never touch `/Applications`.                             |
| `--force`         | Build even if `HEAD` is unchanged; also emits a plist that failed verification.       |
| `--print-launchd` | Emit a ready-to-use LaunchAgent plist on stdout.                                      |
| `--diff-launchd`  | Diff that plist against the installed one. `0` same, `1` differs, `2` none installed. |

> **The interval is 12 hours on purpose, and the examples below use it.** Installing a
> tighter loop by copying an example is not a small mistake: `--install` force-quits the
> running app, replaces the bundle and reopens it, so a two-minute interval is a
> two-minute quit/replace/relaunch cycle on an app that is hosting live Claude sessions
> and serving `:3773`. Use a short interval only in a terminal (Option 3), while watching
> it, and never with `--install`.

## Where things land

| What                  | Path                                                      |
| --------------------- | --------------------------------------------------------- |
| Built `.dmg`          | `<repo>/release/` (override: `T3CODE_DESKTOP_OUTPUT_DIR`) |
| Last-built SHA marker | `~/.t3/userdata/coil-autobuild-last-sha`                  |
| Status JSON           | `~/.t3/userdata/coil-autobuild-status.json`               |
| Log                   | `~/.t3/userdata/logs/coil-autobuild.log`                  |

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

Env overrides: `T3X_AUTOBUILD_STATE_DIR`, `T3CODE_DESKTOP_OUTPUT_DIR` (relative values
resolve against the repo root, matching `build-desktop-artifact.ts`),
`T3X_AUTOBUILD_APPLICATIONS_DIR`, `T3X_AUTOBUILD_KEEP_DMGS` (default `3`, must be a
positive integer). `--print-launchd` copies all of these into the emitted plist, so a
plist generated from a shell where you overrode them keeps those overrides.

`T3X_AUTOBUILD_APP_NAME` overrides the `.app` name during `--dry-run`, short-circuiting
the dmg read; it does not redirect where you install.
`T3X_AUTOBUILD_STDERR_IS_LOG=1` stops `log()` echoing to stderr — set automatically in the
generated plist, where stderr already points at the log file.

**Exit codes:** `0` success · `3` nothing to do (HEAD unchanged, or another instance holds
the lock) · `1` build or install failed · `2` bad flag, invalid env value, or a
TCC-protected repo path.

## Running it hands-off

### Option 1 — LaunchAgent (starts at login)

> **🔴 Your repo must NOT live in `~/Documents`, `~/Desktop`, `~/Downloads`, or iCloud
> Drive.** Those are TCC-protected. LaunchAgents get no TCC grant and — unlike apps —
> never trigger a consent prompt, so macOS just returns `EPERM`. The agent loads,
> `launchctl print` cheerfully reports it, and it dies instantly with
> `last exit code = 126`, having built nothing:
>
> ```
> shell-init: error retrieving current directory: getcwd: … Operation not permitted
> /bin/bash: …/scripts/coil/auto-build-desktop.sh: Operation not permitted
> ```
>
> `--print-launchd` detects this and refuses to emit a plist (exit `2`) rather than hand
> you one that silently never works. Move the repo somewhere unprotected — `~/Developer`
> is the conventional spot:
>
> ```bash
> mkdir -p ~/Developer
> mv ~/Documents/t3code ~/Developer/t3code
> git -C ~/Developer/t3code worktree repair   # plus each worktree, if you use them
> ```
>
> The alternative — granting Full Disk Access to `/bin/bash` — works, but grants FDA to
> _every_ bash script on the machine. Not worth it for this. Option 3 needs no move at
> all, since a terminal already has the grant.

```bash
scripts/coil/auto-build-desktop.sh --print-launchd \
  --ref origin/main --install --relaunch --interval 43200 \
  > ~/Library/LaunchAgents/dev.coil.autobuild.plist
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/dev.coil.autobuild.plist
```

These are the flags the agent on this machine actually runs with, and they are the ones to
copy. `--ref origin/main` builds a fetched remote ref in a dedicated worktree rather than
whatever branch the checkout happens to be on, so an agent working in the repo cannot change
what gets installed.

**Verify it actually runs** — a loaded agent is not a working one:

```bash
launchctl print "gui/$UID/dev.coil.autobuild" | grep -E "state|pid|last exit code"
tail -f ~/.t3/userdata/logs/coil-autobuild.log
```

Want `state = running` with a pid and `last exit code = (never exited)`. A
`last exit code = 126` means the TCC problem above.

Stop / remove it:

```bash
launchctl bootout "gui/$UID/dev.coil.autobuild"
rm ~/Library/LaunchAgents/dev.coil.autobuild.plist
```

`--print-launchd` substitutes the real repo path, script path, interval and log
path, and mirrors `--install` into the emitted `ProgramArguments`.

#### The agent's `PATH` is derived, and verified before anything is emitted

A LaunchAgent does not inherit your shell's `PATH`. launchd starts jobs from a minimal
environment with no login shell, so nothing `fnm`, `asdf`, `volta`, `nvm` or `rustup` writes
into a shell profile is ever read — every directory the build needs has to be named in the
plist. `--print-launchd` therefore resolves `node`, `pnpm`, `cargo` and `git` itself,
following each symlink to a **stable** directory (a version manager's shim usually lives in a
per-shell directory that is deleted when that shell exits, and baking one into a plist
produces a `PATH` entry that quietly stops existing).

It then re-runs each tool from an _empty_ environment — the environment launchd will actually
use — and **refuses to emit anything** if one is unreachable, or if `node` resolves to a
different major version than `package.json`'s `engines.node` allows. Both refusals exit `2`
and print what is wrong. `--force` emits anyway.

The version check earns its keep more than the missing-tool check does. A missing `cargo`
fails loudly enough to find (`spawn cargo ENOENT`, every tick, backing off). A _wrong_ node
does not fail at all: the system almost always has some other node, so the build succeeds and
installs a binary built against a toolchain nobody chose.

Use `--diff-launchd` to see whether the installed agent still matches what the script would
emit today. It compares settings and ignores comments, so hand-written notes in the live
plist do not show up as differences:

```bash
scripts/coil/auto-build-desktop.sh --diff-launchd \
  --ref origin/main --install --relaunch --interval 43200
```

Pass it the same flags the agent runs with — `launchctl print "gui/$UID/dev.coil.autobuild"`
shows what those were — or the only difference it reports will be the flags themselves.

> **A plist fix does not reach an already-installed agent.** launchd keeps the copy it was
> bootstrapped with, so pulling a change to what `--print-launchd` emits — a new environment
> variable, a wider `PATH` — leaves the running agent on the old one. Regenerate and reload:
>
> ```bash
> scripts/coil/auto-build-desktop.sh --diff-launchd \
>   --ref origin/main --install --relaunch --interval 43200   # see the gap first
> launchctl bootout "gui/$UID/dev.coil.autobuild"
> scripts/coil/auto-build-desktop.sh --print-launchd \
>   --ref origin/main --install --relaunch --interval 43200 \
>   > ~/Library/LaunchAgents/dev.coil.autobuild.plist
> launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/dev.coil.autobuild.plist
> ```
>
> Re-run this after any commit that touches the `--print-launchd` block, and pass the same
> flags you installed with — the emitted plist only carries the ones you give it.

### Option 2 — git hook (read the warning first)

> **This repo already sets `core.hooksPath = .vite-hooks/_`** and ships a full hook set
> there (`pre-commit`, `commit-msg`, `pre-push`, `post-checkout`, its own `post-merge`, …).
> That breaks the two obvious install methods:
>
> - `git config core.hooksPath scripts/coil/hooks` **silently disables every one of those
>   hooks** — that directory contains only `post-merge`. Do not do this.
> - `ln -sf … .git/hooks/post-merge` **never fires at all**, because git ignores
>   `.git/hooks` entirely once `core.hooksPath` is set.

The dispatcher at `.vite-hooks/_/h` runs `.vite-hooks/<hook-name>` if that file exists, so
the correct way to add one here is to create the **user-hook** file:

```bash
printf '%s\n' 'exec "$(git rev-parse --show-toplevel)/scripts/coil/hooks/post-merge"' \
  > .vite-hooks/post-merge
chmod +x .vite-hooks/post-merge
```

`scripts/coil/hooks/post-merge` is the sample body it delegates to; it backgrounds a
build-only run so `git pull` returns immediately.

**Honestly, prefer Option 1 or 3.** The hook fires a detached build on _every_ merge, so
two quick `git pull`s start two builds. They no longer corrupt each other (the script
takes a lock and the second exits immediately), but you still get a redundant queued
rebuild, and a `.vite-hooks/post-merge` file is one more thing for the daily upstream
rebase to trip over.

### Option 3 — run the watcher in a terminal

```bash
scripts/coil/auto-build-desktop.sh --watch --install --interval 43200
```

A shorter `--interval` is reasonable here only _without_ `--install`: with it, every tick
that finds a new SHA quits and replaces the running app.

In `--watch` mode the script re-execs itself under `caffeinate -s` so the Mac won't sleep
mid-build; the re-exec forwards every flag, so `--watch --install --dry-run` stays a dry
run. A failed build logs and the loop keeps polling (with backoff) — it never crashes
out.

## Caveats & risks

- **Builds take minutes.** Each poll builds whatever `HEAD` is _now_. Note this does
  **not** perfectly collapse rapid commits: the SHA is sampled _before_ the build and
  recorded _after_, so a commit landing mid-build causes one redundant rebuild of an
  already-current tree. The bias is deliberate — it can waste a build, never skip one.
- **`--install` is disruptive.** It quits the running app (`osascript quit`), replaces the
  target in `/Applications`, and copies the new one in. Fine overnight; annoying
  mid-session. There is no "skip if app is foregrounded" check yet. The new build is
  staged alongside and swapped in, so a failed copy leaves your existing app intact.
- **Signed but not notarized.** Quarantine-stripping is still required on every
  install. If macOS tightens Gatekeeper this may stop working. Signing fixes the
  permission-prompt problem (#70), not the Gatekeeper one.
- **Disk — bigger than the prune suggests.** `T3X_AUTOBUILD_KEEP_DMGS` (default 3) prunes
  `*.dmg` **only**. electron-builder also writes a `.zip` of comparable size (~233 MB
  next to a ~236 MB dmg), plus `.blockmap`s and `builder-debug.yml`, and **none of those
  are pruned** — the zips accumulate one per version. Clear `release/` by hand
  periodically, or set `T3CODE_DESKTOP_OUTPUT_DIR` somewhere you don't mind growing.
- **First build after a lockfile change** runs `pnpm install --frozen-lockfile`,
  which adds time.
- **Repeated failures back off.** A failing build/install is retried with exponential
  backoff (2×, 4×, … up to 32× the interval, capped at 30 min) rather than every
  `INTERVAL`, so a persistent fault — an unwritable `/Applications` on a managed Mac, a
  full disk, a committed type error — can't rebuild all night.
- **Only one runs at a time.** The build+install+marker sequence takes a lock in the state
  dir; a second instance logs "another auto-build is already running" and skips. A lock
  whose owner died is cleared automatically.

## Out of scope (the "real" auto-update path)

The fully hands-off alternative is to **code-sign + notarize** the build, publish
the `.dmg` to the fork's GitHub Releases, and let the app's built-in
`electron-updater` pull it (`T3CODE_DESKTOP_UPDATE_REPOSITORY=radroid/t3code`).
That removes the local watcher entirely but needs an Apple Developer signing
cert, notarization, and a macOS CI publish workflow. Deferred until the local
pipeline proves insufficient.
