# t3x seam ledger

**The authoritative list of every upstream-owned file this fork edits.**

Measured, not asserted: **34 upstream-owned files, +1466 / -112 lines**, against merge-base
`89c5a192f`. Everything else the fork adds lives in new files upstream has never seen and cannot
conflict.

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

## Reading the risk column

`risk = (fork lines changed) × (upstream commits touching that file in the 60 days before the
merge-base)`. It is a rebase-pain estimate, not a correctness signal: a big fork edit to a file
upstream never touches is cheap, and a two-line edit to a file upstream rewrites weekly is expensive.

## The ledger

Sorted by risk, worst first.

| Upstream file                                                           | fork Δ   | churn | risk     | Why the fork touches it                                                                                                                          |
| ----------------------------------------------------------------------- | -------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/ChatView.tsx`                                  | +151/-1  | 55    | **8360** | Thread outbox: `handleQueueComposerSubmission`, queue-mode state, `onSend` early-return, `<ThreadOutboxQueueList>`, `sendLabel`                  |
| `pnpm-lock.yaml`                                                        | +83      | 56    | **4648** | Web Push adds `web-push` + `@types/web-push`. Unavoidable and always conflicts; regenerate rather than merge                                     |
| `packages/client-runtime/src/connection/supervisor.test.ts`             | +363     | 3     | **1089** | Issue #21: 356-line appended `describe` + harness plumbing                                                                                       |
| `apps/web/src/components/settings/SettingsPanels.tsx`                   | +58      | 13    | **754**  | Needs-input notifications: import, 3 restore-reducer entries, permission state, a 45-line `<SettingsRow>`                                        |
| `apps/server/src/serverRuntimeStartup.test.ts`                          | +149/-1  | 5     | **750**  | Crash-recovery reconciler coverage                                                                                                               |
| `packages/client-runtime/src/connection/supervisor.ts`                  | +164/-47 | 3     | **633**  | Issue #21: in-place rewrite of the reconnect/backoff state machine, incl. a 41-line upstream block replaced by 2                                 |
| `packages/contracts/src/ipc.ts`                                         | +28      | 22    | **616**  | `DesktopNotificationRequest` / `Activation` + two optional `DesktopBridge` members                                                               |
| `apps/web/src/components/chat/ChatComposer.tsx`                         | +16/-2   | 30    | **540**  | Threads `sendLabel` / `canQueue` through the composer                                                                                            |
| `apps/mobile/src/features/threads/ThreadComposer.tsx`                   | +26/-4   | 16    | **480**  | Mobile Return-key send/queue                                                                                                                     |
| `apps/server/src/serverRuntimeStartup.ts`                               | +29      | 6     | **174**  | `reconcile.interrupted-turns` startup phase                                                                                                      |
| `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` | +33      | 5     | **165**  | Shift+Return newline vs. bare Return submit                                                                                                      |
| `apps/desktop/src/preload.ts`                                           | +12      | 13    | **156**  | `showNotification` + `onNotificationActivated` on the exposed bridge                                                                             |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`               | +29      | 5     | **145**  | Backend heap headroom (`NODE_OPTIONS`)                                                                                                           |
| `apps/web/src/components/chat/ComposerPrimaryActions.tsx`               | +53/-13  | 2     | **132**  | Queue button; extracts upstream's inline stop button                                                                                             |
| `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`          | +42      | 3     | **126**  | Heap-headroom assertions                                                                                                                         |
| `packages/shared/src/composerTrigger.test.ts`                           | +31/-1   | 3     | **96**   | `replaceTextRange` newline coverage                                                                                                              |
| `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts`       | +20/-8   | 3     | **84**   | Issue #4: CLI probe timeout + spawn-error classification                                                                                         |
| `apps/server/src/server.ts`                                             | +3       | 25    | **75**   | The intended mount point: one import, one `Layer.provideMerge`, one route entry                                                                  |
| `packages/contracts/src/settings.ts`                                    | +7/-2    | 14    | **70**   | `notifyOnNeedsInput` (**persisted schema**) + Claude `homePath` placeholder/description                                                          |
| `apps/desktop/src/main.ts`                                              | +4       | 17    | **68**   | `ElectronNotification` layer                                                                                                                     |
| `apps/web/src/connection/platform.ts`                                   | +7/-1    | 7     | **56**   | Lazy `import()` of outbox cleanup to dodge a module-init cycle                                                                                   |
| `apps/web/src/routes/__root.tsx`                                        | +6       | 9     | **54**   | Mounts `<NotificationCoordinator>`, `<ThreadOutboxDrain>`, `<PushSubscriptionManager>`                                                           |
| `apps/mobile/…/T3ComposerEditorView.kt`                                 | +51      | 1     | **51**   | Android bare-Enter intercept                                                                                                                     |
| `apps/desktop/src/ipc/channels.ts`                                      | +2       | 11    | **22**   | Two notification channel constants                                                                                                               |
| `apps/server/package.json`                                              | +2       | 11    | **22**   | `web-push` dependency                                                                                                                            |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                            | +2       | 9     | **18**   | Registers the `showNotification` handler                                                                                                         |
| `apps/mobile/src/native/T3ComposerEditor.types.ts`                      | +5/-1    | 3     | **18**   | Reworded `onSubmit` doc comment                                                                                                                  |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`                | +2       | 4     | **8**    | Mounts `<AutoResumeOverlay>`                                                                                                                     |
| `apps/web/index.html`                                                   | +5       | 1     | **5**    | PWA manifest + meta tags                                                                                                                         |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`               | +1       | 5     | **5**    | `notifyOnNeedsInput` in a fixture                                                                                                                |
| `apps/mobile/src/native/T3ComposerEditor.native.tsx`                    | +3       | 1     | **3**    | Plumbs `onComposerSubmit`                                                                                                                        |
| `apps/mobile/src/components/AppSymbol.tsx`                              | +2       | 1     | **2**    | `return:` icon entry                                                                                                                             |
| `apps/mobile/…/T3ComposerEditorModule.kt`                               | +1       | 1     | **1**    | Event-name list entry                                                                                                                            |
| `docs/providers/claude.md`                                              | +76/-31  | ~0    | **~0**   | Fixes the broken multi-account recipe. Near-frozen upstream (last touched 2026-04-29) — **the one row worth upstreaming**, which would remove it |

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

That prints exactly the upstream-owned files the fork edits. Churn for any one of them:

```bash
git log --oneline --since="60 days ago" "$MB" -- <path> | wc -l
```

Re-run both after every upstream sync and update this file. If the ledger and this document
disagree, the ledger is right.
