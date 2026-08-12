# Renaming the fork's identity from `t3x` to `coil`

Issue [#71](https://github.com/radroid/t3code/issues/71). The landing site was rebranded to Coil in
PR #69 and deliberately stopped there. This moves everything else.

The rename itself is mechanical. What makes it a design problem is that four of the strings being
renamed are load-bearing for something that outlives the merge: a monotonic counter GitHub derives
from a filename, a hostname compiled into builds already on disk, a path baked into a LaunchAgent
plist, and a macOS Keychain service name. Each one fails silently — no error, no log line, just a
capability that quietly stops working. The bulk of this document is about those four.

## Decisions

| Question                          | Decision                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Scope                             | All four stages of the issue, including the relay                                       |
| App name                          | `T3 Coil (Alpha)`                                                                       |
| Bundle id                         | `dev.curlycloud.coil` → `dev.curlycloud.t3coil`                                         |
| Signing certificate               | `T3X Code Signing` → `T3 Coil Code Signing`                                             |
| First renamed build               | One-time manual install; the updater's refusal is reworded, not bypassed                |
| Relay                             | `coil-update-relay` becomes authoritative; `t3x-update-relay` stays deployed as a proxy |
| GitHub secrets and repo variables | Keep the `T3X_` prefix                                                                  |

Two of these have a cost that is paid by the user rather than by CI, and both are worth restating
because neither is recoverable by editing code after the fact.

**The bundle id and the certificate each cost one full round of macOS permission dialogs.** macOS
keys TCC grants — Screen Recording, Accessibility, Files & Folders — on the pair
`(service, bundle id)`, and the _designated requirement_ that authenticates the app names both the
bundle id and the signing certificate. Changing either invalidates every existing grant. Changing
both at once costs one round of prompts, not two, which is the only reason to do them together.
This is the second such reset in a week (PR #85 was the first), and it should be the last: both
values are now the ones the fork intends to keep.

**Neither cost is incurred at merge time.** It lands when the renamed build is installed. So
`DESKTOP_BUNDLE_IDENTIFIER` and `MAC_SIGNING_IDENTITY_NAME` are single constants in
`scripts/coil/mac-signature.ts`, with a test that fails if their four downstream copies drift —
changing them before merge is a one-line edit, and after merge is a permission reset.

## The four silent failures

### 1. The build counter is keyed to a filename

`t3x-release.yml:80` sets `BUILD_COUNTER: ${{ github.run_number }}`, and `:122` spends it as the
version's prerelease identifier. `run_number` is scoped to a workflow, and GitHub identifies a
workflow by its **file path**. Renaming the file to `coil-release.yml` therefore does not continue
the sequence — it starts a new one at 1.

That interacts badly with the one comparison the updater actually makes (`decision.ts:118`):

```ts
if (manifest.buildNumber <= installed.buildNumber) {
  return { kind: "skip", reason: "not-newer" };
}
```

Published builds are at 26 and the workflow's `run_number` is at 32. A renamed workflow would
publish build 1, every installed client would evaluate `1 <= 26`, and all of them would skip
forever. There is no error surface for this: skipping is the normal, expected outcome of that
branch, so it looks exactly like being up to date.

Issue #71 names this hazard but attributes it to the _version string_, and concludes the suffix
change is safe because the updater never compares versions. Both halves of that are true and
neither is the risk. The risk is the filename.

**Resolution.** Rename the file and offset the counter, doing the addition in bash:

```yaml
env:
  BUILD_COUNTER_OFFSET: 100
  RUN_NUMBER: ${{ github.run_number }}
run: |
  BUILD_COUNTER=$((RUN_NUMBER + BUILD_COUNTER_OFFSET))
```

Not in the expression. **GitHub's expression syntax has no arithmetic operators** — the operator
list stops at comparison and logic — so `${{ github.run_number + 100 }}` is not a wrong value, it
is a parse failure that takes the entire file down. The run appears, contains no jobs, and the only
diagnostic offered is "this run likely failed because of a workflow file issue". Caught by CI on
the first push of this branch, which is the only reason it is written down here rather than
discovered on a release.

100 clears both the current run (32) and the published high-water mark (26) with room that no
plausible backfill closes. The first coil build is 101. The offset is permanent and load-bearing —
removing it later re-creates the same failure — so it carries a comment saying so, and the step
asserts the resolved counter is above 26 rather than trusting the arithmetic.

Two smaller consequences of the same rename:

- `parseBuildNumber` (`config.ts`) matches `/-t3x\.(\d+)$/`. It gains `-coil.N` and **keeps**
  `-t3x.N`. Keeping it is not for old clients — those run their own old code against their own old
  version and are unaffected — but for the interim where a `-t3x.` release is still the newest
  thing on disk while new code reads it, and so that the regex documents both eras.
- The changelog anchors on `git tag --list 't3x-build-*'`. Unchanged, the first coil release finds
  no previous tag, takes the "first release ever" branch, and emits an empty changelog; the
  `--max-count=20` cap keeps that from being catastrophic but the entry is still wrong. The lookup
  spans both prefixes, permanently.

### 2. The relay hostname is compiled into builds already on disk

`config.ts:24` hardcodes `https://t3x-update-relay.businesses.workers.dev`. The env override exists
but no normal install sets it — deliberately, because a `.app` launched from Finder inherits
launchd's environment and not a shell's. So every shipped build polls that exact hostname for as
long as it runs, and if the hostname stops answering they go silent with no channel left to tell
them.

`coil-update-relay` becomes the authoritative Worker and `DEFAULT_RELAY_URL` points at it. The old
hostname stays deployed permanently, serving the same data.

**The shim proxies; it does not redirect.** The issue suggests "proxy or 302". Those are not
equivalent here. `relayClient.ts` talks to the relay through Effect's `HttpClient`, not raw `fetch`,
and it classifies any non-2xx response as `bad-status` on both tiers. Whether that client follows a
307 on a streaming `text/event-stream` response is not a fact that can be established against builds
already in the field, and being wrong about it strands every one of them. A pass-through —
`return fetch(rewrittenUrl, request)` — is byte-identical to today's behaviour from the client's
side, streams SSE without special handling, and depends on nothing about redirect semantics. It
costs the same handful of lines.

**Verification before cutover, against a real old build.** The `T3X_UPDATE_RELAY_URL` override does
work when the `.app` is launched from a terminal rather than Finder, which makes it possible to
point the _currently installed_ build at a throwaway shim and confirm both `/latest` and `/events`
behave. That is the only test that proves anything about clients in the field, so it is a gate on
the relay cutover rather than a nice-to-have.

The old Worker keeps its Durable Object migration tag but stops using the binding; it holds no state
once it is a proxy, so it cannot drift from the new one. Rollback is redeploying the current worker
source, which stays in git history.

### 3. A LaunchAgent plist hardcodes a script path

The installed LaunchAgent — `dev.` + `t3x` + `.autobuild.plist`, on disk, outside this repo —
names the pre-rename script path absolutely in its `ProgramArguments`:
`/Users/rajdholakia/Developer/t3code/scripts/<old>/auto-build-desktop.sh --watch`. Moving that
directory to `scripts/coil/` leaves launchd invoking a path that no longer exists. launchd does not
report this anywhere the user looks; the nightly build simply stops happening. Issue #41 is the same
failure class and cost 103 minutes before anyone noticed.

**Resolution.** The plist is reinstalled as a cutover step —
`scripts/coil/auto-build-desktop.sh --print-launchd --install` — and the agent label moves to
`dev.coil.autobuild`, so the old agent must be unloaded rather than overwritten: a plist under the
old label keeps running from its own copy of the arguments.

The `T3X_AUTOBUILD_*` environment names inside the plist are **not** renamed, which is what keeps
this a one-step migration rather than two. The plist has to be regenerated anyway because the
script path moved, and a regenerated plist and an unchanged script agree by construction; renaming
the variables as well would have created a window where a hand-edited plist sets names the script
no longer reads, silently reverting to defaults for the build worktree and the applications
directory. The state files it writes (`<state-dir>/coil-autobuild-last-sha` and
`coil-autobuild-status.json`) _do_ move, because losing them costs exactly one redundant rebuild.

### 4. `app.setName()` sets a Keychain service name

`DesktopAppIdentity.ts:122` calls `electronApp.setName(environment.displayName)`. On macOS,
Electron's `safeStorage` derives its Keychain item from the app name, and
`DesktopSavedEnvironments.ts` uses `safeStorage` to encrypt saved-environment bearer tokens. Renaming
the app therefore points `safeStorage` at a Keychain item that does not exist, and previously saved
tokens do not decrypt.

Threads, settings and sessions are **not** affected, and this is worth stating precisely because the
adjacent literals look like they should be. `userDataDirName = "t3code"` and
`legacyUserDataDirName = "T3 Code (Alpha)"` (`DesktopEnvironment.ts:171-172`) are hardcoded, not
derived from `displayName` or from the bundle id. That is why PR #85 moved nobody's threads, and it
is why this rename does not either. Renaming _those_ would orphan every thread and is out of scope.

**Resolution.** Accept the re-encrypt, but make it legible: the decode path is verified to degrade
to a per-environment "re-enter this token" state rather than an error or an empty list. No
migration is possible — the new build cannot decrypt what the old name encrypted — so the only
choice is whether the user finds out from a clear prompt or from a confusing failure.

## What is deliberately not renamed

| Kept                                         | Why                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `userDataDirName` / `legacyUserDataDirName`  | Renaming orphans every thread, setting and session                                                                                  |
| GitHub secrets and repo variables (`T3X_*`)  | Invisible to users and to macOS; renaming opens a window between merge and re-setting them where the release is broken, for no gain |
| `~/.t3x/mac-signing`, `t3x-signing.keychain` | Local paths on one machine; moving them adds a manual step to an already manual certificate rotation                                |
| `t3codeCommitHash`, `@t3tools/*`, `T3CODE_*` | Upstream's identity, not the fork's                                                                                                 |
| `apps/marketing/`                            | Untouched by design — see SEAMS.md's parallel-path note                                                                             |

## Seam impact

Every fork edit on an upstream-owned file to date is `+N/-0`. That invariant is what makes the
rebase check meaningful: because the fork only appends, anything that displaced upstream content
would show up as a moved deletion count, so the count itself is the signal.

This change breaks it deliberately, in exactly two places:

- `APP_BASE_NAME` in `apps/desktop/src/app/DesktopEnvironment.ts`
- `productName` in `apps/desktop/package.json`

Both are one-line literal replacements — the smallest possible displacement, and the reason
`T3 Coil (Alpha)` was chosen over an unsuffixed `T3 Coil`, which would have meant restructuring
`resolveDesktopAppBranding` instead. `SEAMS.md` is re-baselined and gains a carve-out naming these
two lines, so a future sync reads the `-2` as recorded rather than as drift.

## Cutover

Ordering follows the issue's, with the relay last because it is the only step that cannot be
rolled back by reverting a commit.

1. **Docs, scripts, source directories, IPC surface.** No runtime effect.
2. **App identity.** Name, bundle id, certificate, reworded refusal.
3. **Release identity.** Tags, version suffix, the counter offset.
4. **Automation.** Workflow filenames, the `coil-sync` label, `coil/sync-*` branch and recovery-tag
   prefixes. These are matched by _running_ workflows, so they land together, and they land only
   when no sync issue or sync PR is open. `coil-ci.yml`'s push trigger matches both branch prefixes
   for one cycle.
5. **Relay.** Deploy `coil-update-relay`, verify the shim against an installed build, then redeploy
   the old hostname as the proxy.

Manual steps, all in the PR body: create the `coil-sync` label, unload and reinstall the LaunchAgent,
rotate the signing certificate and re-record the designated requirement, deploy both Workers, and
drag the first dmg once.

## Verification

- `parseBuildNumber` covers `-coil.N`, `-t3x.N`, and an unsuffixed upstream version.
- `mac-signature.test.ts` still enforces that the bundle id agrees across all four of its copies.
- `installTarget.test.ts` covers the reworded refusal and asserts it still refuses.
- Relay worker tests cover the proxy path for `/latest` and `/events`.
- Typecheck, lint and the full test suite.
- The first coil release is checked by hand for `buildNumber: 101` and a non-empty changelog before
  anything is expected to update itself.
