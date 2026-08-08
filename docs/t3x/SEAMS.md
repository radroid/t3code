# t3x seam ledger

**The authoritative list of every upstream-owned file this fork edits.**

Measured, not asserted: **37 upstream-owned files, +1949 / -925 lines**, against merge-base
`64bf01619` (the 2026-08-02 upstream sync). Everything else the fork adds lives in new files upstream
has never seen and cannot conflict.

> **Read the two dependency rows with their note, not their number.** The 2026-08-08 security sweep
> took `pnpm-lock.yaml` to +318 / -737 and so to risk **67520**, five times the next row. That figure
> is the formula working as designed on a file the formula does not describe: the lockfile is
> **regenerated** at every sync, never merged, so a thousand changed lines cost one `pnpm install`,
> not a thousand conflict decisions. What actually carries the sweep across a sync is the 18-line
> `overrides:` block in `pnpm-workspace.yaml` (risk 667) — that is the row to defend. Most of the
> lockfile delta is not even fork intent: it is astro 7.0.3 → 7.2.0 shedding its old
> remark/rehype/hast pipeline, which is why the file **shrinks** by 413 net lines.

> **Update delivery adds no NEW rows.** Almost all of the feature
> (`docs/superpowers/specs/2026-08-03-update-delivery-design.md`) is new fork-owned files —
> `infra/t3x-update-relay/`, `.github/workflows/t3x-release.yml`, `scripts/t3x/`,
> `apps/desktop/src/t3x/updateDelivery/`, `apps/desktop/src/ipc/methods/t3xUpdate.ts`,
> `packages/contracts/src/t3x/`, `apps/web/src/components/t3x/` — plus the `pnpm-lock.yaml`
> row below. Two things that would each have cost a row were solved at the workflow level instead:
> silencing upstream's updater is done by building with `GITHUB_REPOSITORY: ""` rather than editing
> `DesktopUpdates.ts`, and serialising the desktop build for #47 is done with
> `vp run build:desktop --concurrency-limit 1` rather than editing `build-desktop-artifact.ts`.
> The integration landed on **existing** rows and grew six of them — `contracts/src/ipc.ts`,
> `preload.ts`, `ipc/channels.ts`, `ipc/DesktopIpcHandlers.ts`, `main.ts`, `__root.tsx` — by +57
> lines in total. Each is the aggregator-shaped edit the rule above asks for: one import and one
> optional `t3xUpdate` member on `DesktopBridge`, four channel constants, three `ipc.handle` calls,
> one layer, one mounted component. The bridge's own type and its IPC handlers live in fork-owned
> files (`contracts/src/t3x/updateDelivery.ts`, `ipc/methods/t3xUpdate.ts`), so the interfaces can
> grow without touching upstream again.

The churn and risk columns are measured against that same merge-base, over the 60 days preceding it —
the 46 commits absorbed by this sync are now inside the window, so every figure below moved.

> **Baseline correction, 2026-08-05.** The line totals above were previously recorded as `+1616`
> while the tree measured `+1627`, because the [Regenerating](#regenerating) script resolved the
> merge-base through the **local** `main`, which had drifted 62 commits behind `origin/main` (sync
> PRs land by force-push, so local `main` diverges rather than fast-forwards). The script now uses
> `origin/main`. Two consequences worth knowing:
>
> - The file list and line totals are correct as of this edit — verified by regenerating against
>   `origin/main`, which yields the same 34-file / `+1627` surface the stale path did, plus the new
>   `AGENTS.md` row.
> - The true merge-base against `origin/main` is now `30c96228` (2026-08-02), not `64bf01619`. The
>   churn and risk **columns** still use the `64bf01619` window, so they remain internally
>   consistent with each other but are one sync stale. Re-baselining them is a full regeneration and
>   was deliberately not folded into this commit. Expect small shifts when it happens —
>   `AGENTS.md`, for example, is churn 10 / risk 60 at `64bf01619` and churn 9 / risk 54 at
>   `30c96228`.

Regenerate this ledger before trusting it — see [Regenerating](#regenerating) at the bottom. An
earlier version of this file claimed the surface was 2 files and "Contracts / persistence: _None._"
while it was in fact 34 files including a persisted schema change, which is how issue #29 (a
recurring rebase conflict in a file this doc said the fork did not touch) went unnoticed.

> **Rule:** a new feature registers itself through `apps/server/src/t3x/index.ts` (or the equivalent
> per-surface aggregator) — **never** by adding a fresh edit to an upstream file. If a change
> genuinely cannot avoid touching upstream code, it gets a row here.
>
> **Tripwire:** the surface is already far past "a handful of rows". Before adding row 36, re-isolate
> something instead. Prefer fork-owned files even when an in-place edit is smaller.
>
> Rows 36 and 37 were both added on 2026-08-08, by the Dependabot cleanup. They are the one shape
> the tripwire cannot redirect: a dependency version has no fork-owned home. `pnpm-workspace.yaml`
> (row 37) holds the transitive security `overrides:`, appended to a block upstream already
> maintains; `apps/desktop/package.json` (row 36) holds the one pin on a package this repo declares
> directly. Both are version strings with no logic in them, and both retire themselves as upstream's
> tree floats past — check them at every sync and delete what is no longer needed. If the override
> list ever stops shrinking, that is the signal to re-ask whether the fork should be tracking
> upstream's dependency advisories at all.
>
> Row 35 (`AGENTS.md`) was added knowingly on 2026-08-05, against this tripwire. The alternatives —
> a tracked `.claude/settings.json` SessionStart hook, or an untracked `CLAUDE.local.md` — were
> rejected for being Claude-Code-only and worktree-local respectively. It is six lines of prose in a
> prose file, so it conflicts cheaply; the config it points at is all fork-owned. If a better
> discovery mechanism appears, this is the first row to retire.
>
> **Self-reference:** if your change edits a file that already has a row here, update that row and
> the header totals **in the same commit**. This ledger measures the tree the commit creates, not the
> tree it started from — a commit that edits `docs/user/providers-claude.md` and leaves the row alone
> makes this document wrong the moment it lands. That has already happened once.

## Reading the risk column

`risk = (fork lines changed) × (upstream commits touching that file in the 60 days before the
merge-base)`. It is a rebase-pain estimate, not a correctness signal: a big fork edit to a file
upstream never touches is cheap, and a two-line edit to a file upstream rewrites weekly is expensive.

## The ledger

Sorted by risk, worst first.

| Upstream file                                                           | fork Δ   | churn | risk      | Why the fork touches it                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------- | ----- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                        | +318/-737 | 64   | **67520** | Web Push adds `web-push` + `@types/web-push`; update delivery adds the `t3x-update-relay` workspace entry (+6, `effect` + `@cloudflare/workers-types` only — `wrangler` is run via `pnpm dlx` precisely to keep it out of here, it would have cost ~500); the electron 41.10.3 pin re-resolves the electron tree; the 2026-08-08 security sweep re-floats astro / postcss / svgo / js-yaml / undici@7 and applies the `overrides:` block below. Net **-419 lines** — astro 7.2.0 drops its old remark/rehype/hast pipeline. Unavoidable and always conflicts; **regenerate rather than merge**, which is why this row's risk number overstates it — see the note under the header |
| `apps/web/src/components/ChatView.tsx`                                  | +181/-1  | 63    | **11466** | Thread outbox: `handleQueueComposerSubmission`, queue-mode state, `onSend` early-return, `<ThreadOutboxQueueList>`, `sendLabel`, steer-vs-queue predicate, dispatch breadcrumb                                                                                                                                    |
| `packages/client-runtime/src/connection/supervisor.test.ts`             | +363     | 5     | **1815**  | Issue #21: 356-line appended `describe` + harness plumbing                                                                                                                                                                                                                                                        |
| `packages/client-runtime/src/connection/supervisor.ts`                  | +186/-63 | 5     | **1245**  | Issue #21: in-place rewrite of the reconnect/backoff state machine; now also owns the shared `runLivenessProbe` helper upstream's probe path uses                                                                                                                                                                 |
| `apps/web/src/components/settings/SettingsPanels.tsx`                   | +58      | 18    | **1044**  | Needs-input notifications: import, 3 restore-reducer entries, permission state, a 45-line `<SettingsRow>`. **Not registered in upstream's new settings-search catalog** — see the note below the table                                                                                                            |
| `packages/contracts/src/ipc.ts`                                         | +44      | 22    | **968**   | `DesktopNotificationRequest` / `Activation` + two optional `DesktopBridge` members; **t3x update delivery** adds one type import, one `export type` re-export and a third optional member (`t3xUpdate`). Its interfaces live in fork-owned `src/t3x/updateDelivery.ts`                                            |
| `apps/server/src/serverRuntimeStartup.test.ts`                          | +149/-1  | 6     | **900**   | Crash-recovery reconciler coverage                                                                                                                                                                                                                                                                                |
| `apps/web/src/components/chat/ComposerPrimaryActions.tsx`               | +130/-64 | 4     | **776**   | Queue button; hoists upstream's inline stop and send buttons so the running-turn footer can pair Stop with either. Must mirror upstream's `sendDisabledReason` gate                                                                                                                                               |
| `apps/web/src/components/chat/ChatComposer.tsx`                         | +16/-2   | 34    | **612**   | Threads `sendLabel` / `canQueue` through the composer                                                                                                                                                                                                                                                             |
| `pnpm-workspace.yaml`                                                   | +23      | 29    | **667**   | **Row 37, added 2026-08-08.** 13 major-scoped entries appended to upstream's existing `overrides:` block: brace-expansion ×3 lines, builder-util-runtime, fast-uri, form-data, hono, ip-address, nanoid@3, path-to-regexp, shell-quote, tar, undici@6. These are the transitive advisories Dependabot cannot auto-fix — it only ever bumps a `package.json`. Together with the re-resolution pass they took the fork from **107 open alerts to 6**. Additive and contiguous inside a block upstream already owns, so it conflicts as one hunk. This is the row that carries the sweep across a sync — the lockfile is regenerated from it. Drop entries as upstream's tree floats past them |
| `apps/mobile/src/features/threads/ThreadComposer.tsx`                   | +26/-4   | 16    | **480**   | Mobile Return-key send/queue                                                                                                                                                                                                                                                                                      |
| `apps/desktop/src/preload.ts`                                           | +29      | 13    | **377**   | `showNotification` + `onNotificationActivated` on the exposed bridge, plus the `t3xUpdate` bridge object (get / subscribe / restart / dismiss)                                                                                                                                                                    |
| `apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` | +33      | 6     | **198**   | Shift+Return newline vs. bare Return submit                                                                                                                                                                                                                                                                       |
| `apps/server/src/serverRuntimeStartup.ts`                               | +32      | 6     | **192**   | `reconcile.interrupted-turns` startup phase, inside upstream's `startup` effect between `settings.start` and `reactors.start`                                                                                                                                                                                     |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`               | +29      | 6     | **174**   | Backend heap headroom (`NODE_OPTIONS`)                                                                                                                                                                                                                                                                            |
| `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`          | +42      | 4     | **168**   | Heap-headroom assertions                                                                                                                                                                                                                                                                                          |
| `packages/contracts/src/settings.ts`                                    | +7/-2    | 18    | **162**   | `notifyOnNeedsInput` (**persisted schema**) + Claude `homePath` placeholder/description                                                                                                                                                                                                                           |
| `apps/desktop/src/main.ts`                                              | +9       | 17    | **153**   | `ElectronNotification` layer + the `T3xUpdateDelivery` layer                                                                                                                                                                                                                                                      |
| `docs/user/providers-claude.md`                                         | +86/-33  | 1     | **119**   | Fixes the broken multi-account recipe. Upstream renamed this from `docs/providers/claude.md` in #4807 — **the one row worth upstreaming**, which would remove it                                                                                                                                                  |
| `apps/desktop/src/ipc/channels.ts`                                      | +9       | 12    | **108**   | Two notification channel constants + four `t3x:update-*` constants. Deliberately **not** reusing upstream's `desktop:update-*` channels                                                                                                                                                                           |
| `packages/shared/src/composerTrigger.test.ts`                           | +31/-1   | 3     | **96**    | `replaceTextRange` newline coverage                                                                                                                                                                                                                                                                               |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                            | +11      | 8     | **88**    | Registers the `showNotification` handler + three `t3xUpdate` handlers                                                                                                                                                                                                                                             |
| `apps/server/src/server.ts`                                             | +3       | 29    | **87**    | The intended mount point: one import, one `Layer.provideMerge`, one route entry                                                                                                                                                                                                                                   |
| `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts`       | +20/-8   | 3     | **84**    | Issue #4: CLI probe timeout + spawn-error classification                                                                                                                                                                                                                                                          |
| `apps/web/src/routes/__root.tsx`                                        | +9       | 9     | **81**    | Mounts `<NotificationCoordinator>`, `<ThreadOutboxDrain>`, `<PushSubscriptionManager>`, `<T3xUpdateToast>`                                                                                                                                                                                                        |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`                | +10/-6   | 5     | **80**    | Mounts `<AutoResumeOverlay>` as a sibling of `<ChatView>` inside upstream's render-state conditional                                                                                                                                                                                                              |
| `AGENTS.md`                                                             | +6       | 10    | **60**    | `## Agent skills` pointer block for the mattpocock engineering skills. Three one-line links into `docs/t3x/agents/`; no config lives here. Placed between `## How it works` and `## Where code lives` — stable anchors, deliberately not appended at EOF where upstream adds tips (the issue #29 add/add pattern) |
| `apps/web/src/connection/platform.ts`                                   | +7/-1    | 7     | **56**    | Lazy `import()` of outbox cleanup to dodge a module-init cycle                                                                                                                                                                                                                                                    |
| `apps/mobile/…/T3ComposerEditorView.kt`                                 | +51      | 1     | **51**    | Android bare-Enter intercept                                                                                                                                                                                                                                                                                      |
| `apps/desktop/package.json`                                             | +1/-1    | 15    | **30**    | **Row 36, added 2026-08-08 against the tripwire below.** `electron` pinned to `41.10.3`, not upstream's `41.5.0`, for GHSA advisories #94 (high: sandboxed iframe bypasses `allow-popups` via OpenURL) and #92 (medium: `ProtocolResponse.url` reuses the default session cache). Upstream is still on `41.5.0`, so the sync does **not** carry this fix and the fork ships its own desktop builds. Deliberately **not** folded into row 37's `overrides:` block: electron is a dependency `apps/desktop` *declares*, and an override would leave that manifest reading `41.5.0` while resolving `41.10.3`. Overrides are for transitive packages no manifest here declares. Retire this row the moment upstream passes `41.10.3`: take upstream's side of the conflict |
| `apps/server/package.json`                                              | +2       | 15    | **30**    | `web-push` dependency                                                                                                                                                                                                                                                                                             |
| `apps/mobile/src/native/T3ComposerEditor.types.ts`                      | +5/-1    | 3     | **18**    | Reworded `onSubmit` doc comment                                                                                                                                                                                                                                                                                   |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts`               | +1       | 7     | **7**     | `notifyOnNeedsInput` in a fixture                                                                                                                                                                                                                                                                                 |
| `apps/mobile/src/native/T3ComposerEditor.native.tsx`                    | +3       | 2     | **6**     | Plumbs `onComposerSubmit`, now inside upstream's `<TextInputWrapper>` paste shell                                                                                                                                                                                                                                 |
| `apps/web/index.html`                                                   | +5       | 1     | **5**     | PWA manifest + meta tags                                                                                                                                                                                                                                                                                          |
| `apps/mobile/src/components/AppSymbol.tsx`                              | +2       | 2     | **4**     | `return:` icon entry                                                                                                                                                                                                                                                                                              |
| `apps/mobile/…/T3ComposerEditorModule.kt`                               | +1       | 1     | **1**     | Event-name list entry                                                                                                                                                                                                                                                                                             |

**Per surface:** `apps/web` 8 · `apps/mobile` 7 · `apps/desktop` 7 · `apps/server` 5 ·
`packages/**` 5 · `docs/` 1 · repo root 2.

> **Settings search (new at the 2026-08-02 sync).** Upstream added a settings search catalog
> (`apps/web/src/components/settings/settingsSearch.ts`) and every upstream `<SettingsRow>` now
> spreads `{...searchableSetting("<id>")}` instead of passing a literal `title`. The fork's
> "Notify when an agent needs input" row still passes `title` directly, so it renders and works but
> **cannot be found by settings search**. Registering it means adding an entry to
> `SETTINGS_SEARCH_ITEMS` — a new row on this ledger in a file the fork does not otherwise touch —
> so it was deliberately left unregistered at this sync (the tripwire above). Nothing enforces
> registration: no test asserts that every rendered row is in the catalog, so this will stay silent.

### Files deliberately removed from this surface

- `packages/contracts/src/settings.test.ts` — the fork's `notifyOnNeedsInput` block sat at the same
  `describe` anchor upstream keeps appending to, producing the add/add conflict in issue #29. Moved
  to `packages/contracts/src/t3x/settings.t3x.test.ts`; the upstream file is byte-identical again.
  **This is the pattern to copy:** fork test cases belong in a `t3x/` sibling, never appended to an
  upstream spec.

## Logic mirrors (semantic dependencies, not code seams)

Upstream helpers the fork **replicates** rather than imports, to avoid a code seam. These never
conflict during rebase, so nothing warns you when the original changes and the mirror drifts.

| Fork mirror                                                                         | Mirrors upstream                                                                                                                        | Risk if upstream changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/t3x/autoResume/guards.ts` (`hasOpenBlockingRequest`)               | `decider.ts` (private, unexported)                                                                                                      | Could miss a new blocking-request activity kind and auto-resume into a prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/server/src/t3x/autoResume/http.ts` (`authenticateWithOperateScope`)           | `http.ts` (`authenticateRawRouteWithScope`, private, unexported)                                                                        | `/api/t3x/auto-resume` could authenticate more weakly than the routes beside it. **Checked 2026-08-02: `apps/server/src/http.ts` had no upstream commits this range — the mirror is still accurate.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/server/src/orchestration/Layers/CrashRecoveryReconciler.ts` (`getSnapshot()`) | `ProjectionSnapshotQuery.getSnapshot()` vs. the lighter `getCommandReadModel()`                                                         | **Live risk, found at the 2026-08-02 sync — not yet fixed.** Upstream moved its own orchestration-snapshot route off `getSnapshot()` onto `getCommandReadModel()` in this range, commenting that hydrating every message and activity payload "has OOM-killed servers". The fork's boot reconciler still calls `getSnapshot()`, and it runs on the startup path **before commands are accepted**, so an OOM there is a hard boot failure rather than one slow request. Both return `OrchestrationReadModel` and the reconciler only reads `thread.session` / `thread.latestTurn` metadata, so the swap looks like a drop-in — but it was deliberately left out of the sync commit and needs its own PR with coverage. |
| `apps/web/src/outbox/**` (thread outbox)                                            | `apps/mobile/src/state/thread-outbox-*.ts` (upstream-authored, still maintained)                                                        | The web outbox is a hand port of upstream's mobile one, function for function. Three divergences are deliberate: the web queue drops image attachments (mobile persists them as base64 data URLs, which localStorage cannot hold), orders on an explicit `sortKey` for user reordering where mobile sorts on `createdAt` alone, and steers rather than queues on a running turn where mobile still queues (`apps/mobile/src/features/threads/composerSendLabel.ts`). Upstream reworking its mobile outbox produces no conflict here.                                                                                                                                                                                  |
| `apps/web/src/t3x/AutoResumeOverlay.tsx` (`COMPOSER_OVERLAY_SELECTOR`)              | `apps/web/src/components/ChatView.tsx` — the `[data-chat-composer-overlay="true"]` element it measures for `composerOverlayHeight`      | **Read-only DOM dependency, not a code seam.** The auto-resume capsule is anchored bottom-right above the composer (the toast viewport is `fixed z-100` and top-anchored, so the old top-right placement was covered by any toast — fully so below `sm`). The overlay is mounted as a sibling of `<ChatView>` in the route file and cannot receive the composer height as a prop without widening that seam, so it measures the element via `ResizeObserver`. If upstream renames or drops the attribute the capsule falls back to a fixed 76px offset and stays usable — it would sit slightly wrong, not break. Re-check the attribute at each sync.                                                              |
| `apps/web/src/outbox/composerSteering.logic.ts` (steer allowlist)                   | Each adapter's mid-turn `sendTurn` behaviour (ClaudeAdapter.ts:3729, CursorAdapter.ts:916, GrokAdapter.ts:921, OpenCodeAdapter.ts:1417) | **No capability flag exists** — `ProviderAdapterCapabilities` has no `supportsSteering`, so which drivers fold a mid-turn send into the running turn is asserted by a hand-maintained allowlist. If upstream changes an adapter to open a new turn instead, nothing fails here; the fork would keep sending mid-turn into a provider that no longer steers, and a refusal is invisible because `sendTurn` is forked in `ProviderCommandReactor`. Re-check those four `sendTurn` implementations at every sync.                                                                                                                                                                                                        |

### Parallel paths (fork controls that must honour upstream's guards)

Worse than a mirror: the fork adds a **second way to do something upstream already gates**. When
upstream adds a new precondition to its path, the fork's path silently keeps working — no conflict,
no type error, no failing test.

| Fork path                                                | Upstream guard it must mirror                                 | Checked at the 2026-08-02 sync                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSend` queue branch + `ComposerPrimaryActions` "Queue" | `sendDisabledReason` / `threadDetailLoading` (upstream #4830) | Clean — upstream made **no** commits to `ComposerPrimaryActions.tsx` or `ChatComposer.tsx` in `9dd425b22..64bf01619`, and `ChatView.tsx`'s three commits were terminal-allocation and reconnect-state only. The gate is unchanged, so the fork's mirror still matches. |

The queue branch is now narrower than it was: on a connected, running thread whose driver steers, a
submit takes upstream's immediate-send path instead, restoring the mid-turn steering that the outbox
had been intercepting. That means upstream's guards on that path apply again — which is the point —
but it also re-exposes anything upstream changes there, so the row above matters more, not less.

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
- `docs/t3x/**`, `docs/superpowers/specs/**` — including `docs/t3x/agents/**` (issue tracker, triage
  labels, domain-doc rules for the mattpocock engineering skills) and `docs/t3x/adr/`. These sit
  under `docs/t3x/` rather than the skills' default `docs/agents/`, root `CONTEXT.md`, and
  `docs/adr/` precisely because those three are paths upstream could plausibly create.

Note that a fork-created file is only conflict-free if upstream never creates a file at the same
path. Roughly half of the fork's new files sit outside the four `t3x`-named namespaces above, so
that guarantee is weaker than it looks.

### Desktop auto-build (`scripts/t3x/auto-build-desktop.sh`)

**Zero seams.** Shells out to the existing `pnpm dist:desktop:dmg:arm64` rather than importing or
editing `scripts/build-desktop-artifact.ts` (hot), and deliberately adds **no** script entry to the
root `package.json` (also hot) — it is invoked by path. See `docs/t3x/auto-build-runbook.md`.

## Regenerating

```bash
git fetch origin main upstream                             # both refs must be current
MB=$(git merge-base origin/main upstream/main)             # origin/main, NOT local main
git diff --numstat "$MB"..origin/main | while read -r a d p; do
  git cat-file -e "$MB:$p" 2>/dev/null && printf '%s\t%s\t%s\n' "$a" "$d" "$p"
done
```

`origin/main` is load-bearing, the same way `@<epoch>` is below. Sync branches land by
`git push --force-with-lease origin t3x/sync-<id>:main`, so local `main` never fast-forwards — it
**diverges**, and silently. On 2026-08-05 it was 62 behind / 64 ahead, and a regeneration run
through it under-reported the surface by 11 lines while still looking plausible. Sanity-check with
`git rev-list --left-right --count main...origin/main` before trusting a run; anything non-zero on
the left means local `main` is not the fork.

That prints exactly the upstream-owned files the fork edits. Churn for any one of them — anchored to
the merge-base date, **not** to today, so the number is reproducible after the fact:

```bash
MBTS=$(git show -s --format=%ct "$MB")                     # merge-base commit time, epoch seconds
git log --oneline --since="@$((MBTS - 60 * 86400))" "$MB" -- <path> | wc -l
```

The `@<epoch>` form is load-bearing. Git's approxidate parser **silently ignores** a relative suffix
on an absolute date, so `--since="<iso-date> -60 days"` is treated as `--since="<iso-date>"` — an
empty window that returns 0 for every file. Verify the command is working before trusting it:
`apps/web/src/components/ChatView.tsx` should return a number in the 60s, not 0.

**Re-run both after every upstream sync and update this file — including the merge-base hash in the
header.** Every churn and risk figure shifts once the newly absorbed commits fall inside the window,
so a ledger quoting an old merge-base is stale even when its file list is still right. If the
regenerated ledger and this document disagree, the ledger is right.
