# t3x seam ledger

**The authoritative list of every upstream-owned file this fork edits.**

Measured, not asserted: **34 upstream-owned files, +1516 / -136 lines**, against merge-base
`9dd425b22` (the 2026-07-30 upstream sync). Everything else the fork adds lives in new files upstream
has never seen and cannot conflict.

The churn and risk columns are measured against that same merge-base, over the 60 days preceding it —
the 47 commits absorbed by this sync are now inside the window, so every figure below moved.

Regenerate this ledger before trusting it — see [Regenerating](#regenerating) at the bottom. An
earlier version of this file claimed the surface was 2 files and "Contracts / persistence: _None._"
while it was in fact 34 files including a persisted schema change, which is how issue #29 (a
recurring rebase conflict in a file this doc said the fork did not touch) went unnoticed.

> **Rule:** a new feature registers itself through `apps/server/src/t3x/index.ts` (or the equivalent
> per-surface aggregator) — **never** by adding a fresh edit to an upstream file. If a change
> genuinely cannot avoid touching upstream code, it gets a row here.
>
> **Tripwire:** the surface is already far past "a handful of rows". Before adding row 35, re-isolate
> something instead. Prefer fork-owned files even when an in-place edit is smaller.
>
> **Self-reference:** if your change edits a file that already has a row here, update that row and
> the header totals **in the same commit**. This ledger measures the tree the commit creates, not the
> tree it started from — a commit that edits `docs/providers/claude.md` and leaves the row alone
> makes this document wrong the moment it lands. That has already happened once.

## Reading the risk column

`risk = (fork lines changed) × (upstream commits touching that file in the 60 days before the
merge-base)`. It is a rebase-pain estimate, not a correctness signal: a big fork edit to a file
upstream never touches is cheap, and a two-line edit to a file upstream rewrites weekly is expensive.

## The ledger

Sorted by risk, worst first.

| Upstream file                                                           | fork Δ   | churn | risk     | Why the fork touches it                                                                                                                                          |
| ----------------------------------------------------------------------- | -------- | ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`                                  | +158/-1  | 60    | **9540** | Thread outbox: `handleQueueComposerSubmission`, queue-mode state, `onSend` early-return, `<ThreadOutboxQueueList>`, `sendLabel`                                  |
| `pnpm-lock.yaml`                                                        | +83      | 62    | **5146** | Web Push adds `web-push` + `@types/web-push`. Unavoidable and always conflicts; regenerate rather than merge                                                     |
| `packages/client-runtime/src/connection/supervisor.test.ts`             | +363     | 5     | **1815** | Issue #21: 356-line appended `describe` + harness plumbing                                                                                                       |
| `packages/client-runtime/src/connection/supervisor.ts`                  | +186/-63 | 5     | **1245** | Issue #21: in-place rewrite of the reconnect/backoff state machine; now also owns the shared `runLivenessProbe` helper upstream's probe path uses                |
| `apps/web/src/components/settings/SettingsPanels.tsx`                   | +58      | 17    | **986**  | Needs-input notifications: import, 3 restore-reducer entries, permission state, a 45-line `<SettingsRow>`                                                        |
| `apps/server/src/serverRuntimeStartup.test.ts`                          | +149/-1  | 6     | **900**  | Crash-recovery reconciler coverage                                                                                                                               |
| `packages/contracts/src/ipc.ts`                                         | +28      | 23    | **644**  | `DesktopNotificationRequest` / `Activation` + two optional `DesktopBridge` members                                                                               |
| `apps/web/src/components/chat/ChatComposer.tsx`                         | +16/-2   | 34    | **612**  | Threads `sendLabel` / `canQueue` through the composer                                                                                                            |
| `apps/mobile/src/features/threads/ThreadComposer.tsx`                   | +26/-4   | 16    | **480**  | Mobile Return-key send/queue                                                                                                                                     |
| `apps/web/src/components/chat/ComposerPrimaryActions.tsx`               | +56/-13  | 4     | **276**  | Queue button; extracts upstream's inline stop button. Must mirror upstream's `sendDisabledReason` gate                                                           |
| `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` | +33      | 6     | **198**  | Shift+Return newline vs. bare Return submit                                                                                                                      |
| `apps/server/src/serverRuntimeStartup.ts`                               | +29      | 6     | **174**  | `reconcile.interrupted-turns` startup phase                                                                                                                      |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`               | +29      | 6     | **174**  | Backend heap headroom (`NODE_OPTIONS`)                                                                                                                           |
| `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`          | +42      | 4     | **168**  | Heap-headroom assertions                                                                                                                                         |
| `apps/desktop/src/preload.ts`                                           | +12      | 14    | **168**  | `showNotification` + `onNotificationActivated` on the exposed bridge                                                                                             |
| `packages/contracts/src/settings.ts`                                    | +7/-2    | 18    | **162**  | `notifyOnNeedsInput` (**persisted schema**) + Claude `homePath` placeholder/description                                                                          |
| `docs/user/providers-claude.md`                                         | +86/-33  | 1     | **119**  | Fixes the broken multi-account recipe. Upstream renamed this from `docs/providers/claude.md` in #4807 — **the one row worth upstreaming**, which would remove it |
| `packages/shared/src/composerTrigger.test.ts`                           | +31/-1   | 3     | **96**   | `replaceTextRange` newline coverage                                                                                                                              |
| `apps/server/src/server.ts`                                             | +3       | 28    | **84**   | The intended mount point: one import, one `Layer.provideMerge`, one route entry                                                                                  |
| `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts`       | +20/-8   | 3     | **84**   | Issue #4: CLI probe timeout + spawn-error classification                                                                                                         |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`                | +10/-6   | 5     | **80**   | Mounts `<AutoResumeOverlay>` as a sibling of `<ChatView>` inside upstream's render-state conditional                                                             |
| `apps/desktop/src/main.ts`                                              | +4       | 18    | **72**   | `ElectronNotification` layer                                                                                                                                     |
| `apps/web/src/connection/platform.ts`                                   | +7/-1    | 7     | **56**   | Lazy `import()` of outbox cleanup to dodge a module-init cycle                                                                                                   |
| `apps/web/src/routes/__root.tsx`                                        | +6       | 9     | **54**   | Mounts `<NotificationCoordinator>`, `<ThreadOutboxDrain>`, `<PushSubscriptionManager>`                                                                           |
| `apps/mobile/…/T3ComposerEditorView.kt`                                 | +51      | 1     | **51**   | Android bare-Enter intercept                                                                                                                                     |
| `apps/server/package.json`                                              | +2       | 14    | **28**   | `web-push` dependency                                                                                                                                            |
| `apps/desktop/src/ipc/channels.ts`                                      | +2       | 12    | **24**   | Two notification channel constants                                                                                                                               |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                            | +2       | 9     | **18**   | Registers the `showNotification` handler                                                                                                                         |
| `apps/mobile/src/native/T3ComposerEditor.types.ts`                      | +5/-1    | 3     | **18**   | Reworded `onSubmit` doc comment                                                                                                                                  |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`               | +1       | 7     | **7**    | `notifyOnNeedsInput` in a fixture                                                                                                                                |
| `apps/web/index.html`                                                   | +5       | 1     | **5**    | PWA manifest + meta tags                                                                                                                                         |
| `apps/mobile/src/native/T3ComposerEditor.native.tsx`                    | +3       | 1     | **3**    | Plumbs `onComposerSubmit`                                                                                                                                        |
| `apps/mobile/src/components/AppSymbol.tsx`                              | +2       | 1     | **2**    | `return:` icon entry                                                                                                                                             |
| `apps/mobile/…/T3ComposerEditorModule.kt`                               | +1       | 1     | **1**    | Event-name list entry                                                                                                                                            |

**Per surface:** `apps/web` 8 · `apps/mobile` 7 · `apps/desktop` 7 · `apps/server` 5 ·
`packages/**` 5 · `docs/` 1 · repo root 1.

### Files deliberately removed from this surface

- `packages/contracts/src/settings.test.ts` — the fork's `notifyOnNeedsInput` block sat at the same
  `describe` anchor upstream keeps appending to, producing the add/add conflict in issue #29. Moved
  to `packages/contracts/src/t3x/settings.t3x.test.ts`; the upstream file is byte-identical again.
  **This is the pattern to copy:** fork test cases belong in a `t3x/` sibling, never appended to an
  upstream spec.

## Logic mirrors (semantic dependencies, not code seams)

Upstream helpers the fork **replicates** rather than imports, to avoid a code seam. These never
conflict during rebase, so nothing warns you when the original changes and the mirror drifts.

| Fork mirror                                                               | Mirrors upstream                                                 | Risk if upstream changes                                                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/server/src/t3x/autoResume/guards.ts` (`hasOpenBlockingRequest`)     | `decider.ts` (private, unexported)                               | Could miss a new blocking-request activity kind and auto-resume into a prompt.   |
| `apps/server/src/t3x/autoResume/http.ts` (`authenticateWithOperateScope`) | `http.ts` (`authenticateRawRouteWithScope`, private, unexported) | `/api/t3x/auto-resume` could authenticate more weakly than the routes beside it. |

### Parallel paths (fork controls that must honour upstream's guards)

Worse than a mirror: the fork adds a **second way to do something upstream already gates**. When
upstream adds a new precondition to its path, the fork's path silently keeps working — no conflict,
no type error, no failing test.

| Fork path                                                | Upstream guard it must mirror                                 | Checked at the 2026-07-30 sync                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `onSend` queue branch + `ComposerPrimaryActions` "Queue" | `sendDisabledReason` / `threadDetailLoading` (upstream #4830) | Drifted — both bypassed the new "Messages loading" gate; fixed in `8b9f74968`. |

**At every sync, re-check this table**: for each upstream guard listed, confirm the fork's parallel
path still refuses under the same conditions. Upstream's #4830 added the gate to `onSend`'s
immediate-send branch only, and the fork's queue branch returns _before_ it.

## Files owned entirely by the fork (not seams)

- `apps/server/src/t3x/**`, `apps/web/src/t3x/**`, `packages/contracts/src/t3x/**` — feature code
  and the `T3xLayerLive` aggregator.
- `scripts/t3x/**` — fork setup, upstream sync, desktop auto-build (incl. opt-in git hooks).
- `.github/workflows/t3x-*.yml` — `t3x-upstream-sync.yml`, `t3x-weekly-verify.yml`,
  `t3x-sync-resolve.yml`, `t3x-ci.yml` (the fork's PR/main gate; upstream's `ci.yml` needs
  blacksmith runners the fork cannot use).
- `docs/t3x/**`, `docs/superpowers/specs/**`.

Note that a fork-created file is only conflict-free if upstream never creates a file at the same
path. Roughly half of the fork's new files sit outside the four `t3x`-named namespaces above, so
that guarantee is weaker than it looks.

### Desktop auto-build (`scripts/t3x/auto-build-desktop.sh`)

**Zero seams.** Shells out to the existing `pnpm dist:desktop:dmg:arm64` rather than importing or
editing `scripts/build-desktop-artifact.ts` (hot), and deliberately adds **no** script entry to the
root `package.json` (also hot) — it is invoked by path. See `docs/t3x/auto-build-runbook.md`.

## Regenerating

```bash
MB=$(git merge-base main upstream/main)
git diff --numstat "$MB"..HEAD | while read -r a d p; do
  git cat-file -e "$MB:$p" 2>/dev/null && printf '%s\t%s\t%s\n' "$a" "$d" "$p"
done
```

That prints exactly the upstream-owned files the fork edits. Churn for any one of them — anchored to
the merge-base date, **not** to today, so the number is reproducible after the fact:

```bash
MBTS=$(git show -s --format=%ct "$MB")                     # merge-base commit time, epoch seconds
git log --oneline --since="@$((MBTS - 60 * 86400))" "$MB" -- <path> | wc -l
```

The `@<epoch>` form is load-bearing. Git's approxidate parser **silently ignores** a relative suffix
on an absolute date, so `--since="<iso-date> -60 days"` is treated as `--since="<iso-date>"` — an
empty window that returns 0 for every file. Verify the command is working before trusting it:
`apps/web/src/components/ChatView.tsx` should return a number in the 50s, not 0.

**Re-run both after every upstream sync and update this file — including the merge-base hash in the
header.** Every churn and risk figure shifts once the newly absorbed commits fall inside the window,
so a ledger quoting an old merge-base is stale even when its file list is still right. If the
regenerated ledger and this document disagree, the ledger is right.
