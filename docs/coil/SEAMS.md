# coil seam ledger

**The authoritative list of every upstream-owned file this fork edits.**

Measured, not asserted: **41 upstream-owned files, +714 / -5946 lines**, against merge-base
`67c0fc0cda` (the 2026-10-20 sync, a 1480-commit range).

> **2026-10-24 — the Azure DevOps auth seam follows upstream into the forge.** Upstream #23995
> moved provider-specific failure vocabulary out of `VcsProcess.classifyNonZeroExit` into each
> forge's `classifyFailure` hook, which conflicted with the fork's four Azure substrings. They now
> live in `classifyAzFailure` (`AzureDevOpsCli.ts` +11/-0) with their test beside it (+46/-0);
> `VcsProcess.ts` and `VcsProcess.test.ts` are upstream exactly again. The upstream hook is the
> injection point the 2026-09-12 note below said did not exist. Upstream's three new workflows
> (`relay-preview.yml`, `relay-preview-cleanup.yml`, `stale-needs-more-info.yml`) join the
> retired list. Not remeasured otherwise.

> **2026-10-22 — eight more security pins: 3 → 11, +646 → +714.** GitHub's Dependabot alerts for
> `pnpm-lock.yaml` have not updated since the lockfile moved to pnpm 12's two-document format
> (#191): fixed packages stay open and new advisories never appear. Read `pnpm audit` instead.
> It found these eight, and each floor sits inside the range its parent already declares, so no
> manifest changed: `dompurify`, `hono`, `http-cache-semantics`, `ip-address`, `proxy-addr`,
> `seroval`, `shell-quote` and `smol-toml`. Advisories that need an upstream manifest change
> (`@modelcontextprotocol/sdk`, `stream-json`, `sharp`, `katex`) or have no patched release stay
> with upstream. The two rows are measured at merge-base `60b35a1ee0`; churn was not regenerated.

> **2026-10-21 — the app is called T3 Code again: 56 → 41 files, +783 → +646.** The "T3 Coil"
> name (#71) was retired. It was the fork's most conflict-prone seam: upstream keeps writing "T3
> Code" into new code and tests, and three of the five fixes after the 2026-10-20 sync were
> about the name. Fifteen rows went back to upstream exactly: the desktop name
> (`DesktopEnvironment.ts`, `package.json`, `electron-launcher.mjs` and five tests), the web
> fallback and sidebar (`branding.ts` + test, `SidebarChrome.tsx`), both hosted pages, and the
> fork callouts in `README.md` and `docs/user/install.md`. `index.html` keeps its PWA meta tags
> and drops the title rename. Fork builds are now `T3 Code (Beta)`. The bundle id
> (`dev.curlycloud.t3coil`, #70) stays, so a fork build and upstream's Nightly still keep separate
> macOS permissions. The first fork build after this hits the updater's name-mismatch refusal
> once and asks for a manual drag, as it did for #71. `coil` stays as the label for fork-owned
> paths, workflows and commit scopes; users never see it.

> **2026-10-20 — upstream's hosted pages link the fork's download: 54 → 56 files, +778 → +783.**
> Upstream's new hosted empty state and prompt-link landing hardcode "T3 Code" beside a desktop
> download link. `branding.ts` now points that link at `coil.curlycloud.dev/download`, and both
> components read `APP_DISPLAY_NAME`. `SourceControlRepositoryService.ts` moved `+76/-29` →
> `+78/-31` (upstream's skip-existing-parent check sits inside the fork's destination-error
> mapping), and `DesktopLinuxUrlHandler.test.ts` gained the #71 fixture in a new upstream test. The
> other moves are retired workflows upstream kept editing and the lockfile. The churn columns were
> not regenerated; risk is recomputed from the new deltas at the old churn.

> **2026-10-15 — the daily sync re-resolves a lockfile-only conflict itself.** The lockfile
> conflicted in #128 (on its own), #135 and #172. When it is the only conflict left, the sync now
> takes upstream's lockfile, re-runs the install and lets verify judge the result. Any other
> conflict, or a failed install, escalates as before. No seam moved.

> **2026-10-15 — security pins pruned: 20 → 3, +819 → +778.** Upstream's own lockfile already
> resolved 17 of the fork's 20 transitive pins at or above their floors, so they did nothing but
> conflict. The lockfile was re-seeded from upstream's and re-resolved; no package fell below an old
> floor.

> **2026-10-15 — the update toast moved out of `__root.tsx`: +818 → +819, risk 102 → 5.** Upstream
> edited `__root.tsx` 35 times in 60 days, and it conflicted in sync #172. `<CoilUpdateToast>` now
> mounts inside `RunningThreadKeepAlive.tsx`, which is also desktop-only and lives as long as the
> app, and which upstream has committed to once. The toast was already a no-op on web, since the
> web build has no `coilUpdate` bridge.

> **2026-10-15 — mobile Return-to-send retired: 62 → 54 files, +957 → +818.** The mobile composer
> is upstream's again. A soft-keyboard Return inserts a newline, and a hardware Return follows
> upstream's `enterBehavior` setting on iOS. The fork's soft-keyboard submit, Android Enter
> intercept, line-break toolbar button and their tests are gone. All eight files now match upstream.

> **2026-10-14 — absorbed and parked work retired: 65 → 62 files, +1106 → +957.** Upstream now ships
> what most of the parked features did, so the fork uses upstream's versions:
>
> - usage-limit recovery (`UsageLimitRecoveryWorker`, **Auto-resume limited threads**) for auto-resume;
> - thread notifications (`ThreadNotificationCoordinator`) for needs-input notifications;
> - `ProviderRuntimeRecoveryService` for the crash-recovery reconciler.
>
> By decision, Loops, browser Web Push and the web offline outbox went too. Upstream has no
> equivalent, but the parked code no longer compiled against v2 and any port would be a rewrite.
> `coil-parked/` is deleted, with the design docs and evidence that described only those features.
> Recover any of it from `cc969b360c`, the last `main` that carried it.
>
> - **Dead wiring removed:** the desktop `showNotification` / `onNotificationActivated` bridge
>   (`ipc.ts`, `preload.ts`, `channels.ts`, `DesktopIpcHandlers.ts`, `main.ts`), the
>   `notifyOnNeedsInput` setting (stored settings still decode; the key is dropped on the next
>   write), and the `web-push` dependency with its `http_ece` notice. **Rows retired:**
>   `apps/server/package.json`, `third-party-licenses.config.json`, `vite.config.ts` and
>   `DesktopClientSettings.test.ts`.
> - **One workflow retired:** `mobile-android-apk.yml` (upstream #16271) arrived in the 2026-10-12
>   sync. It publishes upstream's Play Store APK hourly on a Blacksmith runner, so every run sat
>   queued on the fork. It is now on the sync script's retire list.

> **Re-baselined 2026-10-12** against `58d253231d`, after a **371-commit** upstream range (issue
> #168, three consecutive failed daily syncs: one red typecheck, then two conflicts). Five
> conflicts: three retired-workflow modify/deletes (kept deleted), the lockfile, and
> `SourceControlRepositoryService.ts`. The code footprint moved only in that file (`+70/-20` →
> `+76/-29`); every other deletion rose because upstream kept editing workflows the fork deletes.
>
> - **Source control moved into packages.** Upstream split each host into its own
>   `@t3tools/source-control-*` package (#17681 and siblings) and made `SourceControlProviderKind`
>   an open branded slug (#17739). `SourceControlProviderDiscovery.ts` became
>   `packages/source-control-core/src/server/discovery.ts`; git followed the rename, so the fork's
>   spawn-error classification applied without a conflict and its row moved with it. The red
>   typecheck that opened #168 was fork-owned code still importing the old in-server paths
>   (`cloneDiagnostics.ts` and `SourceControlProviderDiscovery.test.ts`); both now import the
>   packages.
> - **The lockfile was seeded from upstream's again** and re-resolved with `pnpm install`; the
>   delta is the fork's own importers and the security-override pins.
> - **Marketing:** two upstream commits (`#13240` header wordmark, `#17783` user count). Nothing
>   worth porting to `apps/coil-home`, which carries its own branding.

> **Re-baselined 2026-10-08** against `cdd331b6c3`, after a **547-commit** upstream range (issue
> #161) that carried upstream's orchestration v2 (#2829), Effect 4.0.1 (#16138) and Expo SDK 58 /
> React Native 0.88 RC (#12045). v2 deleted the engine the fork's server features hooked into
> (`OrchestrationEngine`, `ProjectionSnapshotQuery`, `ProviderService`, `contracts/orchestration.ts`,
> the v1 `ClaudeAdapter.ts`). By decision, the sync **parked** those features rather than porting
> them: auto-resume, loops, Web Push, needs-input notifications, the offline outbox, the
> crash-recovery reconciler, and the #21 client-side supervisor changes. Their fork-owned files sat in
> `coil-parked/` until the 2026-10-14 retirement above deleted them.
>
> - **Sixteen rows retired**, all parked seams: `ChatView.tsx`, `ChatComposer.tsx`,
>   `ComposerPrimaryActions.tsx`, `SettingsPanels.tsx`, `SettingsSidebarNav.tsx`, `settingsSearch.ts`,
>   `ThreadRouteView.tsx`, `connection/platform.ts`, `routeTree.gen.ts`, `server.ts`,
>   `serverRuntimeStartup.ts` (+ test), `McpHttpServer.ts`, `ClaudeAdapter.ts` (deleted upstream),
>   and client-runtime `supervisor.ts` (+ test). Three rows added: `vite.config.ts` (lint ignores
>   `coil-parked/**`), `DesktopApplicationMenu.test.ts` (#71 name in a new upstream test), and
>   `scripts/notify-discord-release.test.ts` (reads the retired `release.yml`; now in the sync
>   script's retire list). The code footprint fell from `+2553` to `+1100`; deletions rose only
>   because upstream kept growing the workflows the fork deletes.
> - **Upstream absorbed some of it.** v2 ships usage-limit auto-resume (`UsageLimitRecoveryWorker`),
>   scheduled tasks that overlap loops, opt-in thread notifications (#11481, already a parallel path
>   to the fork's notifier before this sync), and startup run recovery
>   (`ProviderRuntimeRecoveryService`). Check those before porting a parked row.
> - **New CI requirement.** Upstream's `ServerBrowserPage.test.ts` launches a real headless Chromium;
>   `coil-ci.yml`, `coil-upstream-sync.yml` and `coil-sync-resolve.yml` now install it like upstream's
>   `ci.yml` does.
> - **The desktop profile moves.** Upstream's new `DesktopUserData.ts` puts every build on
>   `t3code-v2`; its one-time import reads the fork's old profile names (`T3 Code (Alpha)`, `t3code`)
>   and carries localStorage, not cookies or IndexedDB.
> - **The lockfile was seeded from upstream's, not the fork's** — see its row.

> **Re-baselined 2026-09-28** against `ba79610d16`, after a **191-commit** upstream range (issue
> #159, five consecutive failed daily syncs) and a one-commit second pass (T3 Connect removal copy,
> no seam touched). Nine conflicts: six retired-workflow modify/deletes
> (kept deleted), `channels.ts` (upstream's trackpad channel above the fork's notification
> channels, still `+10/-0`), `__root.tsx` (upstream's `RunningThreadKeepAlive` import beside the
> fork's, still `+9/-0`) and `ComposerPrimaryActions.tsx` (upstream's new inset-shadow tokens carried
> into the fork's `filledStopEmphasis`). The lock merged textually and installs frozen, with the
> sweep's pins unchanged. The code footprint moved by **six lines**. Every deletion moved only
> because upstream kept editing the workflows the fork deletes.
>
> - **Upstream's design-system lint is now a gate.** #13210 made `shadcn/no-restyle` and its
>   siblings errors, and 45 findings in fork-owned UI failed `vp run lint`. The 2026-09-22 note
>   below ("`vp run lint` only warns") no longer holds. Fork UI now passes. The Queue button became
>   a composer-owned message-action pill like upstream's Submit and Refine (#13209), so
>   `ComposerPrimaryActions.tsx` is `+70` → `+65` after a stale comment went too.
> - **A logic mirror had been dead since #6381.** The auto-resume capsule and loop console
>   reproduced the composer's geometry with `chat-composer-horizontal-inset`, a class upstream
>   deleted long ago, and a fixed `max-w-3xl` that the new Chat width setting (#11594) would have
>   broken. They now read `--workspace-gutter-*` and `--chat-max-width` (see Logic mirrors).
> - **One new parallel path, fixed in fork-owned code.** #13764 moved upstream's queue sender to
>   the app root, where it races the outbox drain after a reconnect (see Parallel paths). One
>   diagnostic is accepted as lost: upstream's queued sends no longer pass through `onSend`, so the
>   fork's `logComposerDispatchNow` breadcrumb does not record them.

> **Re-baselined 2026-09-22** against `83bbfa7e87`, after a **66-commit** upstream range (issue
> #156) and a 24-commit second pass (web restyle refactors, no conflicts). Three conflicts: `ci.yml`
> (retired-workflow modify/delete, kept deleted), `channels.ts` (upstream's recording-input channel
> placed above the fork's appended block, still `+10/-0`) and `pnpm-lock.yaml` (regenerated from the
> fork's lock). **Every code seam kept its exact pre-sync footprint** through both passes. Only
> `ci.yml` and the lock moved in the merge. The header also absorbs drift since the last
> re-baseline: `pnpm-workspace.yaml` was `+29` since #155 and #157, while this ledger still said
> `+23`.
>
> - **One parallel-path fix, no conflict involved.** Upstream #10338 keeps a failed attachment
>   upload alive and retries it on reconnect. The fork's offline queue drops attachments without
>   releasing them, and it runs mostly while disconnected, so every dropped attachment would
>   re-upload later. It now releases them (`ChatView.tsx` `+217` → `+220`, and a new
>   parallel-paths row below).
> - **Upstream's new `lint:restyle-ceiling` ratchet (#12982) is not a fork gate.** It lived only in
>   upstream's `ci.yml`, which the fork deletes. Fork UI (`coil/loop/*`, `AutoResumeOverlay.tsx`,
>   the queue button) puts `apps/web/src` at 635 findings against upstream's ceiling of 628.
>   `vp run lint` only warns, so `coil-ci.yml` stays green. Adopting the ratchet needs a fork
>   ceiling or a restyle pass first.

> **Re-baselined 2026-09-20** against `7445aa733a` (upstream `main` as of 2026-09-19), after a
> **335-commit** upstream range (issue #151, two consecutive failed daily syncs; 23 conflicted files,
> six of them retired-workflow modify/deletes). Both halves were regenerated against the same
> merge-base. The footprint moved from **+2988/-4961 to +2688/-5064** (77 → 78 files): three rows
> retired, four added, and every workflow row remeasured because upstream kept editing the files the
> fork deletes.
>
> - **Retired:** `routes/_chat.$environmentId.$threadId.tsx` (upstream #12015 hollowed the route out;
>   the overlay moved to the new `ThreadRouteView.tsx` row), `ComposerPrimaryActions.test.tsx` (the
>   fork's one assertion pinned a label that no longer exists — see below), `scripts/package.json`
>   (upstream #12417 bumped Sharp past the fork's pin).
> - **Added:** `release-desktop.yml` and `desktop-macos-preview-publish.yml` (new upstream workflows,
>   retired on arrival and appended to the policy list in `scripts/coil/sync-upstream.sh`),
>   `ThreadRouteView.tsx`, and `third-party-licenses.config.json` (a PR #148 seam never registered).
> - **Three seams shrank because upstream did the fork's work itself**, the hazard class from the
>   2026-08-17 sync: #11673 ships a client-side queue for a running turn, so the fork's _steer a
>   running turn_ logic (`composerSteering.logic.ts`, deleted) and its label retire and the outbox
>   queues only while disconnected or behind earlier messages (`ChatView.tsx` +237 → +217); #11762
>   rewrote the clone with progress callbacks and its own redacted stderr tail, so the fork's
>   non-zero-exit branch goes and `describeGitCloneFailure` classifies upstream's tail
>   (`SourceControlRepositoryService.ts` +101/-19 → +70/-20); #11679 added an `enterBehavior`
>   setting with its own bare-Return and Shift+Return key commands, so the fork's iOS intercept is
>   now gated on it (`T3ComposerEditorView.swift` +37 → +28).
> - **Two fork-owned files broke on the effect `rc.112 → rc.115` bump with no seam involved:**
>   `HttpServer.TcpAddress` is now `NetAddress.InetAddress` (`coil/http/testAuth.ts`), and effect's
>   `stat` floors nanoseconds where it used to round, so a `+1 ms` `utimes` fixture reads as
>   _stale_ (`coil/loop/sentinel.test.ts`, now `+1 s`). Neither is visible to the rebase. Everything else the fork adds lives in new files upstream has
>   never seen and cannot conflict.

> **2026-09-13 — retire unused inherited workflows: 15 rows, +0/-3691.**
> The repository now carries only the six fork-owned Coil workflows and upstream's manual Windows
> investigation lane. The removed workflows were either already `disabled_manually`, depended on
> infrastructure or credentials this fork does not have, or were superseded by a Coil workflow.
> Full-file deletions are intentional: `scripts/coil/sync-upstream.sh` resolves their
> modify/delete conflicts by preserving the deletion and removes any reintroduced copy before
> committing a sync. Adopting one later therefore requires removing it from that policy list.
>
> This remeasurement also incorporates the dependency commits merged after the 2026-09-12
> re-baseline: `pnpm-lock.yaml` is now `+786/-1130`, and `scripts/package.json` is a new `+1/-1`
> row for the scripts workspace's Sharp bump.

> **2026-09-12 — Azure DevOps auth classification (issue #122): two rows, +108/-0.**
> `+2739/-1071` (59 files) → `+2847/-1071` (61 files), measured against the same `d1d15c67f4`
> merge-base as the re-baseline above. Both rows are `+N/-0`, and both are in
> `apps/server/src/vcs/`, which had no fork edit before today.
>
> - **`VcsProcess.ts` +8/-0.** Four substrings on the `authentication` arm of `classifyNonZeroExit`.
>   They are **prepended** rather than appended for the invariant's sake: appending would have had
>   to rewrite upstream's terminal `normalized.includes("unauthorized")` line to grow a `||`,
>   spending a deletion for nothing.
> - **`VcsProcess.test.ts` +100/-0.** An appended `describe` block, so a rebase can only ever
>   conflict at the end of the file. (It was +101 on the 2026-09-02 base; the sync merge absorbed
>   one blank line.)
>
> **The fork-owned alternative was considered and rejected.** `classifyNonZeroExit` is a private
> function with no injection point; re-classifying from outside would mean a fork-owned wrapper
> around `VcsProcess` that every call site would have to be routed through — a far larger seam than
> four substrings. The tripwire prefers fork-owned files, but not at that price.
> **Re-baselined 2026-09-12** against `d1d15c67f4`, after an **867-commit** upstream range (issue
> #135, ten consecutive failed daily syncs; 26 conflicted files locally, 20 in CI). Both halves were
> regenerated against the same merge-base. The footprint moved from **+2654/-982 to +2739/-1071**;
> 58 → 59 files (one row added, none retired; two `…`-abbreviated Android rows are now spelled out).
>
> **The deletion count rose by 89, and 124 of the 926 lock deletions explain all of it and more.**
> Outside `pnpm-lock.yaml` the deletion total _fell_, 180 → 145: `ChatView.tsx` lost its one
> displacement, `McpHttpServer.ts` its one, `providers-claude.md` 33 → 0 (upstream rewrote the page),
> `ThreadComposer.tsx` 9 → 7 and `T3ComposerEditorView.kt` shrank as upstream absorbed shape the fork
> had added around. Only `serverRuntimeStartup.ts` (+44/-2 → +43/-2) and `DesktopLinuxUrlHandler.test.ts`
> (+1/-1 → +2/-2, a second app-name fixture in a new upstream test) moved the other way, and both are
> the pre-existing hoist and the #71 rename respectively.
>
> **What the merge could not see, and the reviews did** (all fixed on the sync branch, none a
> textual conflict):
>
> - **Upstream #9507 normalised `account.rate-limits.updated`** into status-less utilisation windows
>   and drops the event when the SDK omits `utilization`. Auto-resume and the loop supervisor read the
>   raw `SDKRateLimitInfo` from it. Both taps now read the `runtime.warning` the adapter raises for a
>   rejected window (`detail` is the raw info); the captured-episode fixture stays verbatim and the
>   replay harness converts it on the way in. `adapterReplay.test.ts` pins the new route.
> - **Upstream #9167/#9803/#10421 continue opted-in threads across restarts** by re-marking the session
>   `starting` and parking a resume. The fork's `CrashRecoveryReconciler` matched `starting` and would
>   have settled that turn to `interrupted` one phase later. It now skips `starting`, which after
>   upstream's own pass only ever means "continuation in flight".
> - **Upstream #11265** moved composer contexts to inline references + a structured `context` record
>   and deleted the four `append*ToPrompt` helpers the queue path used (a build break, but the
>   text-only repair would have shipped dangling references; the queue now carries `context`).
> - **Effect rc.112 renamed `Schema.TaggedErrorClass` → `Schema.TaggedError`** (nine fork-only
>   sites); **TypeScript 7** retired the `tsgo` binary (`infra/coil-update-relay` typecheck script)
>   and needs `apps/coil-home` pinned to TS 6 like `apps/marketing`.
> - **Upstream #10021's libsecret helper** hard-fails tests and the desktop build on Linux without
>   `libsecret-1-dev pkg-config`; the three coil workflows on `ubuntu-latest` now install them. The
>   Windows release leg's Spectre component id was a silent no-op (upstream 1665d81bb5) that the new
>   build preflight would have turned into a hard failure.
> - **Two new upstream workflows arrived active**: `cursor-hygiene-webhook.yml` (forwards issue/PR
>   payloads to Cursor once its secrets exist) and `windows-tests.yml` (dispatch-only, harmless).
>   The Cursor workflow was retired with the rest of the unused inherited workflows;
>   `windows-tests.yml` remains as the fork's manual Windows investigation lane.
> - **Logic mirrors:** `composerSendLabel.ts` is retired (upstream grew the inline ternary; the fork
>   takes it); the decider predicate `hasOpenBlockingRequest` mirrors is now `openRequests` (a Map,
>   same accumulation rules); the auth mirror row named a helper that never existed — the real
>   target is `environmentAuthenticatedAuthLayer` + `requireEnvironmentScope` in `auth/http.ts`.
>   `serverRuntimeStartup.test.ts`'s startup doubles gained `getSettings`/`getShellSnapshot`/
>   `GitVcsDriver` for upstream's new `projects.auto-pull` phase.
>
> **Deferred, recorded on the sync PR:** upstream's `PullRequestSyncReactor` bumps `thread.updatedAt`
> every minute for a linked review with moving checks, which the loop supervisor reads as movement;
> the web outbox's retry classifier is still the pre-#10245 message-matching version of mobile's.

> **2026-09-02 — the loops feature, phases 1 and 3–5: five rows, +45/-1.**
> `+2609/-981` (53 files) → `+2654/-982` (58 files). Four of the five are `+N/-0`; the fifth spends
> exactly one deletion, and it is worth knowing which and why.
>
> - **`ClaudeAdapter.ts` +3/-0 (row 44, phase 1)** was added to the table but the header totals were
>   not updated in the same commit, against the self-reference rule below. Corrected here.
> - **`settingsSearch.ts` +14/-0 (row 45)** and **`SettingsSidebarNav.tsx` +2/-0 (row 46)** are the
>   Settings → Loops section. Both are type-forced by the same `Readonly<Record<SettingsPath, …>>`,
>   so they land together or neither compiles.
> - **`routeTree.gen.ts` +21/-0 (row 47)** is generated, not written. It is listed because the
>   regeneration recipe emits it, and it is resolved the way `pnpm-lock.yaml` is: regenerate, never
>   merge.
> - **`McpHttpServer.ts` +5/-1 (row 48, phase 5)** is the only row that displaces an upstream line,
>   and the whole of the fork's `-982`. The file's terminal `export const layer =` was a single
>   `PreviewToolkitRegistrationLive.pipe(...)`; registering a second toolkit needs a
>   `Layer.mergeAll(...)` around it, so that one line is rewritten rather than added beside. There
>   is no additive form of it — a second `export const layer` would shadow the first — so this is a
>   displacement the invariant cannot avoid, not one it caught. **Re-read it at every sync:** an
>   upstream change to that expression conflicts here, and taking either side wholesale silently
>   drops one of the two toolkits.
>
> **The console cost zero rows, which was the point of the design.** `_chat.$environmentId.$threadId.tsx`
> is still **+10/−6** — phase 3 swapped one JSX element and one import for `<ThreadCoilOverlay>`, a
> fork-owned aggregator, so every future per-thread fork surface is now free. `SettingsPanels.tsx`
> (churn 43) and `packages/contracts/src/settings.ts` (churn 38, persisted) were deliberately not
> touched: loop settings live in `coil-loop.json` behind fork-owned routes.
>
> **Two upstream files were deliberately left alone and are worth recording as refusals.**
> `docs/README.md` would take one bullet to link `docs/user/loops.md`, and
> `docs/internals/glossary.md` four terms of loop vocabulary. Neither has a fork edit today, so
> either would open a **new row for prose** against the tripwire below — the vocabulary lived in
> the loops design docs instead. All of it was deleted with Loops on 2026-10-14.

> **Re-baselined 2026-09-02** against `941acb4f9`, after a **182-commit** upstream range
> (issue #128, which escalated on a `pnpm-lock.yaml` conflict). Both halves were regenerated
> against the same merge-base. The footprint moved from **+2613/-1044 to +2609/-981**, and the
> seam set is unchanged at the same 53 files — no row was added or retired.
>
> **The deletion count fell by 63, which is the interesting number.** The additive-seam invariant
> says a fork edit to a shared file should be `+N/-0`, so a _falling_ deletion count means the fork
> is displacing less upstream code than it was. All 63 are accounted for, and only five rows moved
> at all:
>
> - **`apps/desktop/package.json` +2/-2 → +1/-1.** Upstream #8626 moved electron to **43.4.1**,
>   two majors past the fork's 41.10.3 advisory pin, so the pin is **superseded and dropped** —
>   taking `--ours` here (the fork's standing habit on dependency hunks) would have shipped
>   Electron-43-targeted preview code on an Electron 41 runtime, and nothing would have caught it:
>   the only source change in that commit is a shortened `clearStorageData` array, valid under both
>   typings. The row is now the `productName` line alone.
> - **`pnpm-lock.yaml` +490/-871 → +459/-802.** Regenerated seeded from the fork's own pre-sync
>   lock, so the sweep survived (verified: sharp 0.35.3, nanoid 3.3.17, tar 7.5.22, undici 6.28.0,
>   form-data 4.0.6, hono 4.13.0, ip-address 10.4.0, path-to-regexp 6.3.0, shell-quote 1.10.0,
>   fast-uri 3.1.5, builder-util-runtime 9.7.0).
> - **`apps/web/src/components/ChatView.tsx` +217/-1 → +230/-1.** Upstream #8236 added a second
>   attachment class; the fork's queue path knew only about images. Still `-1`.
> - **`T3ComposerEditorView.swift` +33/-0 → +37/-0.** Still fully additive.
> - **`ThreadComposer.tsx` +25/-2 → +36/-9**, the one row that spent deletions. See below.
>
> **`pnpm-workspace.yaml` deserves a line even though its numbers did not move.** Upstream's Expo
> SDK 57 upgrade (#8609) rewrites the exact `overrides:` lines the fork's advisory block sits
> between, and rewrites `patchedDependencies` wholesale — deleting five patch files and adding
> seven. The habitual keep-both resolution would have re-pinned `@expo/metro-config@56.0.14` and
> `expo-modules-jsi@56.0.10` onto an Expo 57 tree and left `patchedDependencies` naming files that
> no longer exist. Resolved as upstream's, with only the 13 fork security keys re-inserted;
> verified afterwards that the block is byte-identical to upstream apart from those keys, and that
> every one of the 17 patch files it names is present.
>
> **`ThreadComposer.tsx` is where this sync spent its deletions, deliberately.** Upstream #8587
> extracted the composer's command menu into `use-composer-command-menu.ts`, taking
> `replaceTextRange`, `composerSelection` and `setComposerSelection` with it, and #8614 rebuilt the
> expanded toolbar around dictation. The fork's line-break button depended on all three. It is
> re-pointed at `composerMenu.selection` / `composerMenu.onSelectionChange`, and the button now
> sits in a wrapper `View` beside upstream's `ComposerAttachmentButton` — that wrapper re-indents
> six upstream lines, which is the whole of the `-7`. It preserves upstream's two-group
> `justify-between` layout rather than adding a third child to it.
>
> **`AppSymbol.tsx` conflicted on the whole file and is worth recording as a near miss.** Upstream
> #8694 replaced the Tabler barrel import with ~78 per-icon deep imports specifically to stop Metro
> eagerly registering the entire icon set. The fork's contribution there is two lines. Taking the
> fork's side of that conflict — or re-adding the one-line named import in upstream's block — would
> have silently reverted a bundler-performance fix that no typecheck, lint or test can see. The
> resolved file has **zero** bare `from "@tabler/icons-react-native"` imports.
>
> **Three fork behaviours broke without any textual conflict**, which is the case this whole
> document exists for. Each is fixed in its own commit on the sync branch: upstream #8600 deleted
> `canSettle`, the outbox drain's idle gate; the same commit made a **server timer** write the
> `settledOverride` the auto-resume guard read as "the user is done here", so armed week-long
> resumes were cancelled on day three; and #8614's new composer read-only mode was jumped by the
> fork's Return-submits interception. Only the first was a build error.
>
> **`apps/marketing` had zero upstream churn in this range**, so the `apps/coil-home` parallel path
> has nothing to port this cycle. No new upstream workflow arrived; `ci.yml` and `release.yml` were
> both modified but remain upstream-owned and inert here.
>
> **Risk numbers rose across most rows without any fork change**, because churn is measured over the
> 60 days before the merge-base. Compare risk within this table, not against the previous
> baseline's.

> **Previously, re-baselined 2026-08-27** against `f6f2be32d`, after a **185-commit** upstream range — eight
> consecutive failed daily syncs (issue #123). Both halves were regenerated against the same
> merge-base. The footprint moved from **+2590/-1042 to +2613/-1044**.
>
> The rebase itself displaced nothing — after conflict resolution the deletion count was still
> exactly `-1042`, which is the property that makes a zero-conflict sync trustworthy, since _any_
> displacement of upstream code moves a deletion count. The two extra deletions were then spent
> **deliberately**, on the ordering fix below. Three rows changed:
>
> - **`serverRuntimeStartup.test.ts` +160/-1 → +173/-1.** Upstream #7719 (`0929907ff`) added an
>   orphaned-provider-session pass to `ServerRuntimeStartup.make`, which gave it two new service
>   requirements. The fork's startup-ordering test drives `make` directly with doubles, so it broke
>   — a **semantic drift no textual conflict would have flagged**. The provider double now reports
>   the seeded thread as live, so the new pass finds no orphans and dispatches nothing; otherwise
>   its dispatch would have landed a second `"reconcile"` in the very `order` ref the test asserts on.
> - **`pnpm-lock.yaml` +492/-871 → +490/-871.** Regeneration seeded from the fork's own pre-sync
>   lock, so the security sweep survived (`sharp@0.35.3`, `nanoid@3.3.17` unchanged) while picking
>   up upstream's new `heic-to@1.5.2`.
> - **`serverRuntimeStartup.ts` +32/-0 → +44/-2**, the one deliberate displacement. Upstream #7719
>   also reconciles orphaned provider sessions at startup, and its pass is the only one that repairs
>   the `ProviderSessionDirectory` binding. The fork's `reconcile.interrupted-turns` ran first and
>   settles a **wider** set of threads (no liveness check — nothing is live at boot), so it left
>   upstream's filter (`starting | running | activeTurnId != null`) matching nothing, and the stale
>   binding silently survived. This is the **parallel-path hazard in its purest form: a fork path
>   that duplicates an upstream capability, bypassing a guard upstream just added.** Upstream's phase
>   is therefore hoisted above the fork's. Upstream runs it after `reactors.start`; the fork cannot,
>   because its own pass must precede any reactor. Caught only by upstream's
>   `orphanedProviderSessionStartup.integration.test.ts` — **not** by the rebase, and **not** by the
>   fork's own unit tests, both of which stayed green while the behaviour was broken.
>
> **`ChatComposer.tsx` deserves its own line even though its numbers did not move.** Upstream moved
> the bottom toolbar, so git presented the fork's change as a 130-line block against an empty
> upstream side — when the original patch was only `+16/-2`. Taking that block would have silently
> reverted upstream's refactor of the approval branch into `isComposerApprovalState`, the same
> stale-hoist failure mode this ledger has recorded twice before. The duplicate was dropped and the
> fork's two props moved onto upstream's `ComposerFooterPrimaryActions`. The row measuring **+16/-2
> afterwards — exactly its pre-sync delta — is the evidence the resolution restored intent rather
> than absorbing upstream code.**
>
> **A pre-existing ledger bug is fixed here:** two rows were both labelled `apps/server/package.json`.
> The `+2/-2` one is `apps/desktop/package.json`, and its "why" was wrong too — it is Electron pinned
> ahead of upstream (41.10.3 vs 41.5.0, from the advisory sweep) plus the #71 `productName`, not a
> `web-push` dependency.
>
> **Risk numbers rose across the board without any fork change**, because churn is measured over the
> 60 days before the merge-base and that window now covers a far busier upstream period. Compare
> risk within this table, not against the previous baseline's.
>
> Three upstream `apps/marketing` commits were checked against the `apps/coil-home` parallel path and
> **deliberately not ported**: #7477 and #7473 both fix serving an Intel Mac build to Apple Silicon,
> and coil-home only ever publishes `darwin-arm64` — there is no Intel artifact to mis-serve — while
> #8070 is Vercel deployment config and coil-home deploys through Cloudflare.

> **Re-baselined 2026-08-17** against `a4cc1367b`, after a 116-commit upstream range (three days of
> failed daily syncs, issue #117). The footprint **shrank** — +2622/-1093 → +2590/-1042 — while
> gaining two rows, and both halves of the movement are worth reading:
>
> - **`ComposerPrimaryActions.tsx` +128/-55 → +74/-5.** Upstream #4781 hoisted its inline send
>   button to a `const` itself, which is the hoist the fork had been carrying since #35. The fork's
>   copy was deleted rather than re-synced, so the **stale-hoist hazard on this row is retired**: it
>   could previously revert an upstream restyle _silently_, because a copy cannot conflict. What is
>   left is upstream's own button plus one aria-label branch. The -55 → -5 is the real signal: the
>   fork had been displacing upstream's running/idle dispatch, and now extends it instead.
> - **`SourceControlProviderDiscovery.ts` +20/-8 → +12/-5.** Upstream #6223 independently fixed the
>   timeout half of issue #4, and better — a per-spec `probeTimeoutMs` with `az` at 20s, against the
>   fork's global 15s. The fork ceded that half entirely; the remaining seam is only the
>   spawn-error classification, which upstream still does not do.
> - **`apps/web/public/manifest.webmanifest` is a new row (+21/-0), not new work.** Upstream now
>   ships its own manifest, so a file that was fork-owned became an add/add seam. Upstream's has no
>   `name`/`short_name`/`description` and no maskable icon, all of which an installable PWA needs
>   for Web Push, so the fork's fields are unioned on top of upstream's.
> - **`ComposerPrimaryActions.test.tsx` is a new row (+5/-1)** — one assertion, argued in the row.
>
> Two upstream marketing commits were checked against the `apps/coil-home` parallel path and
> **deliberately not ported**; see the parallel-path section.

> **Re-baselined 2026-08-14** against `196c8ea0d`, after a 95-commit upstream range (three days of
> failed daily syncs, issue #91). Both halves — file list and churn/risk columns — were regenerated
> against the same merge-base. Only two rows moved on the file-list half, both from conflict
> resolutions in this rebase: `ComposerPrimaryActions.tsx` +118/-48 → +128/-55 (the hoisted
> `sendButton` re-synced to upstream's restored stage-backdrop styling — the hoist went stale in
> exactly the direction the 2026-08-08 note predicted, just reversed), and mobile
> `ThreadComposer.tsx` +27/-4 → +25/-2 (upstream #6543 removed `activeThreadBusy`, and
> `composerSendLabel.ts` was re-mirrored to the new two-condition expression). One fork patch was
> dropped as absorbed: the 2026-08-08 "restore the security sweep's resolutions" lockfile commit
> went empty because this sync's lock was seeded from the fork's pre-sync lock, which already
> carried those pins (verified: sharp 0.35.3, @hono/node-server 2.1.0, nanoid 3.3.17).

> **2026-08-12 (#98): three new rows, and the fourth displacement.** Cloning from Bitbucket reported
> `cloneRepository failed for unknown: The source control operation could not be completed.` — a
> constant `detail` for every cause, and `unknown` for a provider the fork supports. Fixing it costs
> `SourceControlRepositoryService.ts` **+101/-19**, which is the largest displacement in this file
> and has to be argued the way #70's and #71's were.
>
> The argument is that **every one of the 19 is the bug**. Four are the literal `provider: "unknown"`
> the issue named; two are function signatures taking the provider they should always have had;
> seven are the `git.execute` call that discarded git's stderr; the rest are a `let provider` that no
> longer needs reassignment and a one-line `makeDirectory` that now reports what it could not do.
> None of them displace upstream logic that still wants to be there — a message that says nothing is
> not content the fork is stepping over.
>
> **What was kept out of the upstream file matters more than what went in.** The classification, the
> redaction and the non-interactive git env are ~190 lines in a _new_ file,
> `apps/server/src/sourceControl/cloneDiagnostics.ts`, which costs this ledger nothing.
> `NON_INTERACTIVE_GIT_ENV` there is a deliberate second copy of `GitVcsDriverCore`'s private
> `STATUS_UPSTREAM_REFRESH_ENV`: deduping them would have meant a **-7 in a 3090-line file with churn
> in the hundreds**, to save five constant strings with no logic in them. Upstreaming this module is
> what should collapse the two, not a fork edit.
>
> Two shapes were rejected. Detecting the provider **in the clients** is what the issue proposed, and
> it would have cost rows in `CommandPalette.tsx` _and_ `AddProjectScreen.tsx` — two hot UI files —
> to fix one surface each; deriving it on the server fixes web, mobile and every future client from
> one place. Putting the new module under `apps/server/src/coil/` was rejected for the opposite
> reason: this is an upstream bug with no fork-specific behavior in it, and burying it in the fork's
> namespace would make the upstream PR harder than the fix.
>
> **Re-baselined 2026-08-12 for #71**, which renamed the fork's identity from `t3x` to `coil` and
> the app from `T3 Code (Alpha)` to `T3 Coil (Alpha)`. The directory and symbol renames cost
> nothing here — they move fork-owned files, and the fork-added lines inside upstream files change
> content without changing count. The app rename is what moved these numbers: **7 new rows and 2
> grown deletion counts**, argued for below.
>
> Of the deletions, the −134 that #58 added on 2026-08-11 are **all** `pnpm-lock.yaml`, the one row
> the additive invariant below has never covered because it is regenerated rather than merged. The
> remaining −20 are #71's, spread one or two at a time across the nine identity rows. Reading the
> two together is the point: a deletion count that grows is only alarming when it grows on a file
> that is merged rather than regenerated, and only #71's are.

> **Corrected 2026-08-11 (#40).** The header read +1968 while the regeneration recipe below returned
> +1981 against the same `origin/main` — a 13-line drift in the `pnpm-lock.yaml` row (see its own
> note). The drift is persistent, not new: it was +1957 against a recipe run of +1970 before #70 landed,
> the same 13 lines. The +2005 it set was a fresh run of the recipe: 1981 baseline, plus 24 lines this
> issue's A3/A4 fixes add to `ChatView.tsx` (+186/-1 → +210/-1). The count of _files_ has not moved and
> neither has any deletion count, which is the property that matters.

> **The file-list half has now survived two consecutive rebases unchanged** — same 37 files, across
> 49 upstream commits. That is the check, not a formality: the fork's edits are
> additive on every shared file (`preload.ts` +29/-0, `channels.ts` +9/-0, `ipc.ts` +44/-0,
> `__root.tsx` +9/-0), so anything that displaced upstream content would move a deletion count. When
> #5624 removed a line from `channels.ts` and `preload.ts`, the removal survived precisely because
> the fork never re-adds — it only appends.
>
> **2026-08-11: the first exception, and it is a small one.** `scripts/build-desktop-artifact.ts` (#70)
> replaces one line — a constant's initialiser — so the fork's total is no longer +N/-0 on every shared
> file, and the invariant above weakens from "no deletions anywhere" to "one known deletion, at a known
> line". Keep it that way. The additive rule is what makes a clean sync evidence of anything, so a
> second displacement should have to argue for itself in this file the way that one did.
>
> **2026-08-12 (#71): the argument for the second set.** Renaming the app is not expressible as an
> insertion. `T3 Code` has to stop being the name, and every one of these is a literal that already
> exists in an upstream file, so each is a replacement:
>
> | File                                                  |         | What moves                                                                                                                                                                                                                                                                                                                               |
> | ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `apps/desktop/src/app/DesktopEnvironment.ts`          | +9/-1   | `APP_BASE_NAME`. The only one that really matters — `displayName` is derived from it and reaches `app.setName()`, the About panel, window titles, the Linux `.desktop` entry, and the whole web UI through `getAppBranding()`. The other 8 lines are a comment explaining why `legacyUserDataDirName` two lines below must NOT follow it |
> | `apps/desktop/package.json`                           | -1 → -2 | `productName`, the `.app` bundle name                                                                                                                                                                                                                                                                                                    |
> | `apps/desktop/scripts/electron-launcher.mjs`          | +1/-1   | the dev-mode display name                                                                                                                                                                                                                                                                                                                |
> | `apps/web/src/branding.ts`                            | +1/-1   | the browser-only fallback, used when no desktop branding is injected                                                                                                                                                                                                                                                                     |
> | `apps/web/index.html`                                 | -0 → -1 | the boot `<title>`                                                                                                                                                                                                                                                                                                                       |
> | `apps/desktop/src/app/DesktopAppIdentity.test.ts`     | +5/-2   | asserts the new name AND keeps the legacy-userData assertions on the old one                                                                                                                                                                                                                                                             |
> | `apps/web/src/branding.test.ts`                       | +14/-11 | fixtures, minus the injected-branding case which deliberately keeps `T3 Code`                                                                                                                                                                                                                                                            |
> | `apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts` | +1/-1   | fixture                                                                                                                                                                                                                                                                                                                                  |
> | `scripts/build-desktop-artifact.test.ts`              | +4/-1   | asserts `resolveDesktopProductName` returns the fork's name                                                                                                                                                                                                                                                                              |
>
> Five of the nine are tests, which is the cheap half: a test fixture that upstream also edits
> conflicts loudly and is resolved by reading two lines. The four source rows are each a single
> string literal, which is the smallest displacement a rename admits. `T3 Coil (Alpha)` was chosen
> over an unsuffixed `T3 Coil` precisely to keep it that way — dropping the stage label would have
> meant restructuring `resolveDesktopAppBranding` rather than replacing a constant.
>
> **2026-08-12: the third displacement, and the argument for it.** #71 renamed everything the app
> is packaged as and nothing it calls itself on screen, so the sidebar corner still read `Code`
> while the title bar read `Coil`. `SidebarChrome.tsx` is a new row and a `+3/-1`, and the rule
> above says that has to be argued rather than assumed.
>
> The argument is that this is the string that answers _which build am I running_, on a fork that
> ships its own updater beside upstream's Nightly, and that it is bounded: the `T3` glyph beside it
> is shared, so only the word moves.
>
> Two shapes were rejected. Writing `Coil` as a literal would put a second copy of the app's name
> in an upstream-owned component — the duplication `install-instructions.json` already needed a
> test to survive, in a worse place to notice it. **Hoisting `SidebarBrand` into a fork-owned
> component would be worse still**: that is precisely the failure the 2026-08-08 sync recorded,
> where a fork hoist of upstream inline JSX went stale and silently reverted an upstream restyle.
> A hoist converts a loud one-line conflict into a silent revert, which is the wrong trade on a
> file with churn 7.
>
> So the deletion is spent on the smallest thing that removes the duplication: one substituted
> expression, fed by an **additive** `+14` in `branding.ts`, which is where the fork already owns
> a row and where the name is already resolved once.
>
> **What was NOT taken.** 31 further upstream files carry `T3 Code` in body copy ("T3 Code needs the
> relay client…"). Renaming those would nearly double this ledger to buy prose consistency, and is
> deliberately declined. The app's own name is computed, not hardcoded, in every surface that
> matters; the leftovers are sentences.

> **Read the two dependency rows with their note, not their number.** `pnpm-lock.yaml` sits at
> +490 / -871 and so at risk **77577**, still the top row by a wide margin. That figure is the
> formula working as designed on a file the formula does not describe: the lockfile is
> **regenerated** at every sync, never merged, so a thousand changed lines cost one `pnpm install`,
> not a thousand conflict decisions. What actually carries the security sweep across a sync is the
> 23-line `overrides:` block in `pnpm-workspace.yaml` (risk 575) — that is the row to defend, and it
> applied cleanly through this rebase.
>
> **Regenerating the lock is not the same as seeding it from upstream.** This sync's first pass
> resolved all three lock conflicts with `--ours` (upstream's side) and then ran
> `pnpm install --lockfile-only`. That silently reverted the 2026-08-08 security sweep and took
> Dependabot from 6 open alerts back to 27: `--lockfile-only` **keeps any already-present pin that
> still satisfies the semver range** instead of floating to the newest match, so seeding from
> upstream's lock preserved upstream's older resolutions (undici 7.27.1 / 8.9.0, js-yaml 4.2.0,
> postcss 8.5.15, svgo 4.0.1, astro 7.0.3). The `overrides:` block survived byte-identical and did
> not save it. The fix (PR #63) was to seed from the **fork's** pre-sync lock instead —
> `git checkout <pre-sync-tag> -- pnpm-lock.yaml && pnpm install --lockfile-only` — which is why
> this row's deletion count jumped from -143 to -737: the -420 net is astro 7.2.0 dropping its old
> remark/rehype/hast pipeline, and it is the sweep being present, not absent. **Diagnostic trap:** a
> reopened Dependabot alert keeps its original `created_at`, so "every alert predates the sync" does
> not prove the sync innocent. Diff the resolved versions.

> **2026-08-11 (#58): three advisories cleared with nothing but a lockfile re-resolution, and
> nothing in `overrides:` defends them.** sharp 0.34.5 → 0.35.3, `@modelcontextprotocol/sdk`
> 1.29.0 → 1.30.0, `@hono/node-server` 1.19.14 → 2.1.0. Every one is inside a range its parent
> already declares — astro asks for `sharp: ^0.34.0 || ^0.35.0`, `claude-agent-sdk` asks for
> `@modelcontextprotocol/sdk: ^1.29.0`, and SDK 1.30.0 asks for
> `@hono/node-server: ^1.19.9 || ^2.0.5` — so the lock was merely holding a stale resolution and no override was
> needed. **That is exactly what makes them fragile:** the `overrides:` block is what carries the
> 2026-08-08 sweep across a sync, and these three have no entry in it. Regenerate from upstream's
> lock and they revert silently, the same 6 → 27 way. Seed from the fork's pre-sync lock, then diff
> the three resolved versions.
>
> **Technique worth keeping: an auto-installed peer can be re-resolved without `--force`.**
> `@modelcontextprotocol/sdk` is a peer of `@anthropic-ai/claude-agent-sdk` declared in no workspace
> manifest, so `pnpm update --depth Infinity` is a no-op on it and an `overrides:` entry rewrites the
> declared _range_ while leaving the resolved instance alone (re-verified on pnpm 11.10.0 — the
> override lands in the lock's `overrides:` map and 1.29.0 stays put). Deleting the package's own
> top-level blocks from `pnpm-lock.yaml` and re-running `pnpm install --lockfile-only` forces a fresh
> resolution of just that subtree: it floated to 1.30.0 and pulled `@hono/node-server` 2.1.0 with it,
> with zero collateral version changes and no manifest edit. Prefer this to the wholesale `--force`
> re-resolution, which floats everything at once.

> **Corrected 2026-08-11 (#72).** The `pnpm-lock.yaml` row read `+317/-737` and was 13 lines
> stale: `apps/coil-home`'s workspace entry landed across `99b83bf55` (+16), `2a6053745` (-3) and
> `7197fa589` — and none of them moved the row, which is precisely the failure the note above the
> ledger warns about. Regenerating during this change found it. The header total moved with it.

> **Update delivery adds no NEW rows.** Almost all of the feature
> (`docs/superpowers/specs/2026-08-03-update-delivery-design.md`) is new fork-owned files —
> `infra/coil-update-relay/`, `.github/workflows/coil-release.yml`, `scripts/coil/`,
> `apps/desktop/src/coil/updateDelivery/`, `apps/desktop/src/ipc/methods/coilUpdate.ts`,
> `packages/contracts/src/coil/`, `apps/web/src/components/coil/` — plus the `pnpm-lock.yaml`
> row below. Two things that would each have cost a row were solved at the workflow level instead:
> silencing upstream's updater is done by building with `GITHUB_REPOSITORY: ""` rather than editing
> `DesktopUpdates.ts`, and serialising the desktop build for #47 is done with
> `vp run build:desktop --concurrency-limit 1` rather than editing `build-desktop-artifact.ts`.
> (That file has since taken one line for #70 — see below. #47 still does not need it.)
> The integration landed on **existing** rows and grew six of them — `contracts/src/ipc.ts`,
> `preload.ts`, `ipc/channels.ts`, `ipc/DesktopIpcHandlers.ts`, `main.ts`, `__root.tsx` — by +57
> lines in total. Each is the aggregator-shaped edit the rule above asks for: one import and one
> optional `coilUpdate` member on `DesktopBridge`, four channel constants, three `ipc.handle` calls,
> one layer, one mounted component. The bridge's own type and its IPC handlers live in fork-owned
> files (`contracts/src/coil/updateDelivery.ts`, `ipc/methods/coilUpdate.ts`), so the interfaces can
> grow without touching upstream again.

> **The fork homepage adds no NEW rows.** `apps/coil-home/` is a fork-owned copy of
> `apps/marketing/` deployed to Cloudflare (`coil-home` Worker, served at `coil.curlycloud.dev`),
> plus `.github/workflows/coil-deploy-home.yml` — all files upstream has never seen.
> `apps/marketing/` itself remains untouched, which is the whole point: rebranding 1310 lines of
> `index.astro` in place would have put a fork edit on upstream's highest-churn marketing file.
> **Parallel-path hazard:** upstream keeps evolving `apps/marketing/`; the copy will not conflict
> but will silently drift. At each sync, skim
> `git log <merge-base>..upstream/main -- apps/marketing` and port anything worth having (pricing
> changes, new pages, security-relevant fixes) by hand.
>
> **Checked 2026-08-17 — two upstream commits, neither ported, both deliberately:**
>
> - `04f23098e fix(marketing): detect Mac chip on homepage download button (#4197)` probes the WebGL
>   renderer to choose between an arm64 and an x64 macOS asset, because the user-agent says
>   "Intel Mac OS X" on both. **Not applicable:** `coil-release.yml`'s build matrix is exactly two
>   targets, `darwin-arm64` and `win32-x64`, so there is no Intel Mac asset to choose. The fork's
>   pages already say "Apple Silicon (arm64)" outright rather than guessing.
> - `db3278f97 fix(marketing): keep Grok mark clear of mobile hero copy (#4542)` repositions
>   `.hero-float-mark.hf-grok` with new absolute `top`/`left` values on mobile. **Already fixed
>   differently, and porting would regress it:** the fork solved the same collision more thoroughly
>   in `c2244abdf`/`3dd74b7c3` by taking the hero marks out of absolute positioning entirely on
>   mobile and laying them out as an in-flow row. Upstream's coordinates assume the absolute layout
>   the fork no longer has.

> **macOS code signing (#70) costs ONE line on `build-desktop-artifact.ts`, and not the one the issue
> predicted.** The issue expected a third signing mode in that file, because it forces
> `CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned builds. That turned out to be free: app-builder-lib
> consults the flag **only when no identity was named** — `findIdentity()` reads
> `qualifier || process.env.CSC_NAME` first and, when non-empty, goes straight to
> `security find-identity`. So the signing half is entirely fork-owned (`CSC_NAME` exported by
> `.github/workflows/coil-release.yml`), at zero rows.
>
> The row is spent on the **second** cause instead, which no environment variable existed for: macOS
> stores one TCC permission row per `(service, bundle id)`, and the fork shared
> `com.t3tools.t3code` with upstream's nightly — so whichever app launched last owned the grants and
> the other was re-prompted, however well either was signed. `DESKTOP_APP_ID` is now
> `process.env.T3X_DESKTOP_APP_ID?.trim() || "com.t3tools.t3code"`, and the fork sets that variable to
> `dev.curlycloud.t3coil`.
>
> **The shape of the edit is the point.** A changed literal would have been +1/-1 and would have
> broken three upstream assertions in `build-desktop-artifact.test.ts`, adding a second row on a
> second upstream file. An env escape hatch keeps upstream's default, its tests, and its behaviour on
> an unset environment — the same answer as `--concurrency-limit` for #47 and `GITHUB_REPOSITORY: ""`
> for the updater. Before spending a row to change a value, check whether it can become a variable
> upstream would have accepted.
>
> The compensating control for a seam this quiet is in fork-owned tests: `mac-signature.test.ts`
> asserts the hook still exists in that file and that every build path sets it, and
> `verify-mac-signature.ts` fails any artifact whose signing identifier is not the expected one. A
> sync that reverts the line cannot ship silently.

The churn and risk columns are measured against that same merge-base, over the 60 days preceding it.
The window slides forward at every sync, so these figures move even when the fork does not.

> **Re-baselined 2026-08-08.** The churn and risk columns had been one sync stale — measured in the
> `64bf01619` window while the file list was measured against `30c96228` — because re-baselining is a
> full regeneration and had been deferred twice. This sync ran both halves against the same
> merge-base, so the columns and the file list finally agree. The shifts are large and mostly reflect
> the 117-commit range now sitting inside the window: `ChatView.tsx` churn went 63 → 85,
> `ChatComposer.tsx` 34 → 39, `server.ts` 29 → 33.
>
> Regenerated a second time the same day against `a20923ce4`, the follow-up pass that absorbed four
> more upstream commits (the usage page #5684 and its chart fix #5697, the mobile settings sheet
> #5625, the desktop zoom-shortcut fix #5691). Only two rows moved on the file-list half —
> `ThreadComposer.tsx` +26/-4 → +27/-4 and `pnpm-lock.yaml` picking up PR #63's repair — which is the
> check that matters: a sync that silently reverted an upstream change would show up here as a row
> whose fork delta grew without anyone editing it.
>
> **Re-baselined 2026-08-10** against `78f462c4e` (upstream v0.0.33). The file-list half did not move
> a single line across the 49 upstream commits absorbed that day, in two passes.
>
> The second pass exists because of a process failure worth recording: the scheduled
> `coil upstream sync (daily)` workflow force-landed **its own** rebase onto `main` while the reviewed
> sync PR was still open. Both rebased the same 91 fork patches, so `main` and the PR branch ended up
> with identical content under different SHAs and no shared history — which GitHub reports as an
> unresolvable conflict, and which no amount of conflict-fixing on the PR would have cured. The fix
> is to rebuild the branch from the new `main`, not to merge the old one. **Two things follow: check
> `origin/main` immediately before landing any sync, and note that the automation lands without
> updating this ledger** — after that landing the header still claimed merge-base `a20923ce4`, two
> baselines stale, in violation of the self-reference rule above.
>
> The older correction this replaces is still worth knowing: the [Regenerating](#regenerating) script
> once resolved the merge-base through the **local** `main`, which had drifted 62 commits behind
> `origin/main` (sync branches landed by force-push then, so local `main` diverged rather than
> fast-forwarded) and under-reported the surface by 11 lines while looking plausible. The script uses
> `origin/main` now. Sanity-check with `git rev-list --left-right --count main...origin/main` before
> trusting a run.

Regenerate this ledger before trusting it — see [Regenerating](#regenerating) at the bottom. An
earlier version of this file claimed the surface was 2 files and "Contracts / persistence: _None._"
while it was in fact 34 files including a persisted schema change, which is how issue #29 (a
recurring rebase conflict in a file this doc said the fork did not touch) went unnoticed.

> **Rule:** a new feature registers itself through a fork-owned aggregator (`apps/server/src/coil/index.ts`,
> created by the first server feature and wired with one line each into `server.ts`'s route and
> application layers, or the per-surface equivalent) — **never** by adding a fresh edit to an upstream file. If a change
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
merge-base)`. It is a conflict-pain estimate, not a correctness signal: a big fork edit to a file
upstream never touches is cheap, and a two-line edit to a file upstream rewrites weekly is expensive.

## The ledger

### Retired inherited workflows

These full-file deletions are grouped separately from the active code seams. Their conflict policy
is uniform and enforced by the sync script: keep the deletion unless the fork deliberately adopts
the upstream workflow. The one upstream test that reads a retired workflow is listed with them.

| Upstream file                                         | fork Δ   | churn | risk      | Why the fork touches it                                                                                                                                                                            |
| ----------------------------------------------------- | -------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`                       | +0/-1386 | 29    | **40194** | Superseded by `coil-release.yml`; upstream publishing credentials and Blacksmith runners are unavailable here.                                                                                     |
| `.github/workflows/ci.yml`                            | +0/-539  | 19    | **10241** | Superseded by `coil-ci.yml`; the upstream gate requires Blacksmith runners unavailable to the fork.                                                                                                |
| `.github/workflows/release-desktop.yml`               | +0/-663  | 6     | **3978**  | New upstream this range (#11605–#11607 split the desktop release out of `release.yml`); same reasons as `release.yml`.                                                                             |
| `scripts/notify-discord-release.test.ts`              | +0/-642  | 3     | **1926**  | **New 2026-10-08.** Reads `.github/workflows/release.yml`, which the fork retires; it tests the Discord helper only that workflow calls. Listed in `scripts/coil/sync-upstream.sh`'s retire policy |
| `.github/workflows/mobile-eas-production.yml`         | +0/-356  | 4     | **1424**  | The fork does not publish the upstream iOS or Android apps or own their EAS credentials.                                                                                                           |
| `.github/workflows/desktop-macos-preview-publish.yml` | +0/-579  | 2     | **1158**  | New upstream this range; the fork does not publish upstream preview DMGs.                                                                                                                          |
| `.github/workflows/deploy-relay.yml`                  | +0/-97   | 6     | **582**   | The fork does not deploy the upstream T3 Connect relay; Coil update delivery uses its own relay.                                                                                                   |
| `.github/workflows/mobile-showcase-screenshots.yml`   | +0/-180  | 2     | **360**   | The fork does not maintain the upstream mobile store-listing screenshot pipeline.                                                                                                                  |
| `.github/workflows/mobile-eas-preview.yml`            | +0/-111  | 3     | **333**   | The fork does not publish upstream EAS preview builds or own their credentials.                                                                                                                    |
| `.github/workflows/desktop-macos-preview.yml`         | +0/-97   | 3     | **291**   | The fork does not publish upstream preview DMGs and cannot use the configured Blacksmith runner.                                                                                                   |
| `.github/workflows/mobile-fingerprint-check.yml`      | +0/-220  | 1     | **220**   | Only gates the retired EAS production workflow.                                                                                                                                                    |
| `.github/workflows/cursor-hygiene-webhook.yml`        | +0/-52   | 2     | **104**   | The fork does not forward repository events to Cursor hygiene.                                                                                                                                     |
| `.github/workflows/publish-aur.yml`                   | +0/-66   | 1     | **66**    | Only publishes upstream's AUR package and was called by the retired upstream release workflow.                                                                                                     |
| `.github/workflows/mobile-android-apk.yml`            | +0/-50   | 1     | **50**    | Publishes upstream's Play Store APK to a GitHub prerelease hourly; needs upstream's Play credentials and a Blacksmith runner the fork lacks, so every run sat queued.                              |
| `.github/workflows/pr-size.yml`                       | +0/-295  | 0     | **0**     | The fork does not use upstream's PR-size labeling automation.                                                                                                                                      |
| `.github/workflows/pr-vouch.yml`                      | +0/-199  | 0     | **0**     | The fork does not use upstream's contributor-vouch automation.                                                                                                                                     |
| `.github/workflows/web-preview.yml`                   | +0/-132  | 0     | **0**     | The fork does not deploy upstream Vercel previews or own that project's credentials.                                                                                                               |
| `.github/workflows/thread-transfer-report.yml`        | +0/-75   | 0     | **0**     | Depends on the retired upstream CI workflow and has never run on the fork.                                                                                                                         |
| `.github/workflows/issue-labels.yml`                  | +0/-75   | 0     | **0**     | The fork does not use upstream's automatic issue-label setup.                                                                                                                                      |
| `.github/workflows/relay-preview-cleanup.yml`         | +0/-203  | 0     | **0**     | **New 2026-10-24.** Tears down upstream's relay preview stages, with a daily sweep on a `blacksmith` runner the fork does not have. Retired with `deploy-relay.yml`.                               |
| `.github/workflows/relay-preview.yml`                 | +0/-81   | 0     | **0**     | **New 2026-10-24.** Deploys upstream's relay preview stages for labeled PRs; needs upstream's Cloudflare/PlanetScale credentials and `blacksmith` runners.                                         |
| `.github/workflows/stale-needs-more-info.yml`         | +0/-30   | 0     | **0**     | **New 2026-10-24.** Closes issues carrying upstream's `needs more info` label; the fork's triage label is `needs-info`.                                                                            |

### Active seams

Sorted by risk, worst first.

| Upstream file                                                            | fork Δ  | churn | risk      | Why the fork touches it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------- | ----- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`                                                         | +97/-81 | 171   | **30438** | **Seeded from upstream's lock, never merged.** The delta is the fork's own importers (`infra/coil-update-relay`, `apps/coil-home`) and the eleven security pins. Re-resolve with `pnpm install` on top of upstream's lock; a merge of two lockfiles is never the right resolution. **Since 2026-10-15 the daily sync does this itself** when the lockfile is the only conflict (`LOCKFILE_INSTALL` in `scripts/coil/sync-upstream.sh`), so this row's risk mostly no longer reaches a human.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`   | +205/-5 | 11    | **2310**  | **Row 41, added 2026-08-12 (#98).** Coverage for each mapped clone failure — auth, not-found, timeout, unwritable destination — plus one asserting a credential-bearing URL is redacted out of the surfaced message, and one asserting the clone spawn is handed the non-interactive env. The single deletion is the assertion that a `git@github.com:` clone reports provider `unknown`; it encoded the bug **2026-09-20:** the fork's failure cases now drive upstream's `progress.onStderrLine` mock (`failingClone`) instead of a non-zero `ExecuteGitResult`, and upstream's own tail-echo assertion is replaced by the classified sentence — the one place both tests could not be true at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/build-desktop-artifact.ts`                                      | +32/-1  | 39    | **1287**  | **Two env hooks, one displaced line, no new deletions.** Issue #70: `DESKTOP_APP_ID` reads `process.env.T3X_DESKTOP_APP_ID` before falling back to upstream's `com.t3tools.t3code`, so the fork's app owns its own TCC permission rows instead of sharing them with upstream's nightly. Issue #53: `DESKTOP_FILE_EXCLUSIONS` appends `process.env.T3X_DESKTOP_FILE_EXCLUSIONS` (comma-separated globs), taking the packaged asar from 189.66 MiB / 14,765 files to 99.02 MiB / 3,429 and the `.zip` users download by 20.1 MB. Most of the added lines are the comments explaining both. Env hooks rather than changed literals on purpose. For #53 the reason is not row count — `build-desktop-artifact.test.ts` is already a row (see #71 above) — but that the fork's list is **67 globs and grows**: an inline list would make every future size fix an edit to an upstream TEST assertion, resolved by hand at every sync. Through the environment, an unset environment packages precisely what upstream packages and upstream's `deepStrictEqual` keeps passing untouched. Guarded from the fork side by `scripts/coil/mac-signature.test.ts` and `scripts/coil/desktop-bundle-size.test.ts` (both hooks exist, the release workflow sets them, the exclusions never name a package the main process loads) and by two artifact checks: `verify-mac-signature.ts` and `verify-desktop-bundle.mjs` (the shipped app still resolves every import its own bundles make) |
| `apps/server/src/sourceControl/SourceControlRepositoryService.ts`        | +78/-31 | 12    | **1308**  | **Row 42, added 2026-08-12 (#98).** Derives the provider from the remote URL instead of reporting `unknown`, runs the clone with `allowNonZeroExit` so git's stderr can be classified before it is thrown away, and passes the non-interactive env so a credential prompt fails in seconds rather than hanging to the 120 s timeout. All 19 deletions are the defect itself — see the note under the header. The logic lives in the fork-added `cloneDiagnostics.ts`, which costs no row **2026-09-20:** upstream #11762 rewrote the clone around `prepareClone` / progress callbacks / `discardClone` and now keeps a redacted stderr tail itself; the fork's `allowNonZeroExit` branch is gone and `describeGitCloneFailure` classifies upstream's tail instead. `NON_INTERACTIVE_GIT_ENV` is spread into upstream's `CLONE_ENV`. `+101/-19` → `+70/-20`. **2026-10-12:** upstream #17739 made `SourceControlProviderKind` an open branded slug and replaced each `"unknown"` literal with `SourceControlProviderKind.make("unknown")` on the very lines the fork rewrites to carry the derived provider — seven conflict hunks, all resolved to the fork's `provider`, with `resolveCloneProvider` now minting the brand. `BitbucketApi` and `SourceControlProvider` are imported from upstream's new `@t3tools/source-control-*` packages. `+70/-20` → `+76/-29`                                                                                                         |
| `packages/source-control-azure-devops/src/server/AzureDevOpsCli.test.ts` | +46/-0  | 0     | **0**     | Issue #122. Table-driven coverage for the Azure DevOps auth vocabulary in `classifyAzFailure`, with `not-found` and ordinary-failure negatives so the new substrings cannot swallow either. Appended `describe` block. Moved here from `VcsProcess.test.ts` on 2026-10-24                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/contracts/src/ipc.ts`                                          | +16/-0  | 43    | **688**   | **Coil update delivery:** one type import, one `export type` re-export and one optional `DesktopBridge` member (`coilUpdate`). Its interfaces live in fork-owned `src/coil/updateDelivery.ts`. The notification members went on 2026-10-14.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`                | +29/-1  | 22    | **660**   | Backend heap headroom (`NODE_OPTIONS`), the server half of #21 — still live; only the client half (supervisor) was parked on 2026-10-08. **2026-09-20:** upstream #11511 made the WSL launch a `command` array; the heap flag sits in the node-script branch (the file's one deletion). **2026-10-08:** upstream's `T3CODE_CLI_PATH` lands beside `NODE_OPTIONS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/desktop/src/backend/DesktopBackendConfiguration.test.ts`           | +41/-0  | 16    | **656**   | Heap-headroom assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/desktop/src/preload.ts`                                            | +17/-0  | 30    | **510**   | The `coilUpdate` bridge object (get / subscribe / restart / dismiss)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/contracts/src/settings.ts`                                     | +2/-2   | 99    | **396**   | Claude `homePath` placeholder/description. `notifyOnNeedsInput` was removed on 2026-10-14; stored settings that still carry it decode, because the schema ignores unknown keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/user/source-control.md`                                            | +8/-0   | 45    | **360**   | **Row 43, added 2026-08-12 (#98).** States that cloning uses the Git credentials on the machine running T3 Code, not the provider API tokens above it — the confusion the Bitbucket report started from — plus a "Clone failed" troubleshooting entry. Purely inserted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm-workspace.yaml`                                                    | +14/-0  | 54    | **756**   | **Row 37, added 2026-08-08.** Transitive security pins in upstream's `overrides:` block, for advisories Dependabot cannot fix because it only bumps a `package.json`. **2026-10-15: pruned from 20 pins to 3** (`dbus-next>xml2js`, `path-to-regexp@6`, `valibot@1`), because upstream's own lockfile already resolved the other 17 at or above their floors. **2026-10-22: 3 → 11**, for eight advisories `pnpm audit` found inside ranges upstream already declares. The block now sits between `@types/node` and `effect`, two lines upstream rarely edits. To prune again, compare each floor with the versions in upstream's `pnpm-lock.yaml`; a pin is redundant once upstream resolves every copy at or above it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/desktop/src/ipc/channels.ts`                                       | +7/-0   | 24    | **168**   | Four `coil:update-*` constants. Deliberately **not** reusing upstream's `desktop:update-*` channels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/desktop/src/main.ts`                                               | +6/-0   | 19    | **114**   | The `CoilUpdateDelivery` layer, beside upstream's renamed `layerDesktopSsh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AGENTS.md`                                                              | +6/-0   | 17    | **102**   | `## Agent skills` pointer block for the mattpocock engineering skills. Three one-line links into `docs/coil/agents/`; no config lives here. Placed between `## How it works` and `## Where code lives` — stable anchors, deliberately not appended at EOF where upstream adds tips (the issue #29 add/add pattern)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                             | +5/-0   | 16    | **80**    | Registers three `coilUpdate` handlers (`getCoilUpdateState`, `restartIntoUpdate`, `dismissCoilUpdate`), after upstream's new CLI-command handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `docs/user/providers-claude.md`                                          | +5/-0   | 10    | **50**    | **Rewritten upstream this range** (`+86/-33` → `+5/-0`). Upstream condensed the whole page into product voice and covered the `HOME`-vs-`CLAUDE_CONFIG_DIR` point itself; the fork keeps one paragraph — leave the default instance's config directory empty rather than typing `~/.claude` (the email stops being reported and it counts as a different environment). The `claude auth status` recipe, the account-switching section and the `ccr` router recipe were dropped with the rewrite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/source-control-azure-devops/src/server/AzureDevOpsCli.ts`      | +11/-0  | 0     | **0**     | Issue #122. Azure DevOps reports authorization failures as `TF400813` / `VS30063` / "is not authorized" / "Client authentication required", none of which contain the generic `"unauthorized"` substring, so without this the user sees "Azure DevOps CLI command failed." instead of the `az devops login` hint. A separate `if` at the top of `classifyAzFailure`, so the edit is +N/-0. Moved here from `VcsProcess.ts` on 2026-10-24, when upstream moved provider vocabulary into per-forge `classifyFailure` hooks (#23995)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web/public/manifest.webmanifest`                                   | +19/-0  | 1     | **19**    | **New row 2026-08-17, and not new work.** Upstream now ships its own manifest, so a previously fork-owned file became an add/add seam. Upstream's has no `name`/`short_name`/`description` and no maskable icon — an installable PWA needs all four — so the fork's fields are unioned onto upstream's. Web Push (#23), the reason for them, is parked since 2026-10-08; the installable PWA still works without it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/source-control-core/src/server/discovery.ts`                   | +12/-5  | 1     | **17**    | Issue #4. **2026-08-17: the timeout half was ceded to upstream**, which fixed it independently in #6223 and better — a per-spec `probeTimeoutMs` with `az` at 20s, against the fork's global 15s constant, now deleted. The remaining seam is only the spawn-error classification: solely `VcsProcessSpawnError` means "missing", so a slow-but-present CLI stays "available" and the auth probe still runs. Upstream still does not do this **2026-10-12:** upstream #17681-era package split moved this file out of `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts`; git followed the rename and the edit applied unchanged. The fork's test stays in `apps/server` and imports the package                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/web/index.html`                                                    | +4/-0   | 2     | **8**     | PWA manifest + meta tags.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/web/src/components/desktop/RunningThreadKeepAlive.tsx`             | +4/-1   | 1     | **5**     | Hosts `<CoilUpdateToast>` (fork-owned update delivery): one import and the component's `return`. Moved here from `__root.tsx` on 2026-10-15 because upstream rarely edits this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Per surface (2026-10-12):** `apps/desktop` 14 · `apps/mobile` 7 · `apps/server` 5 · `apps/web` 6 · `packages/**` 4 · `docs/` 3 · repo root 8 (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/build-desktop-artifact.ts`, `scripts/build-desktop-artifact.test.ts`, `README.md`, `AGENTS.md`, `vite.config.ts`, `third-party-licenses.config.json`).

### Files deliberately removed from this surface

- `packages/contracts/src/settings.test.ts` — the fork's `notifyOnNeedsInput` block sat at the same
  `describe` anchor upstream keeps appending to, producing the add/add conflict in issue #29. Moved
  to `packages/contracts/src/coil/settings.coil.test.ts`; the upstream file is byte-identical again.
  **This is the pattern to copy:** fork test cases belong in a `coil/` sibling, never appended to an
  upstream spec.

## Logic mirrors (semantic dependencies, not code seams)

Upstream helpers the fork **replicates** rather than imports, to avoid a code seam. These never
conflict during a sync, so nothing warns you when the original changes and the mirror drifts.

**No live mirrors.** Every earlier row described a feature retired on 2026-10-14.

### Parallel paths (fork controls that must honour upstream's guards)

Worse than a mirror: the fork adds a **second way to do something upstream already gates**. When
upstream adds a new precondition to its path, the fork's path silently keeps working — no conflict,
no type error, no failing test.

**No live rows.** All three earlier rows belonged to the web outbox, retired on 2026-10-14.

**At every sync, re-check this table**: for each upstream guard listed, confirm the fork's parallel
path still refuses under the same conditions.

## Files owned entirely by the fork (not seams)

- `apps/desktop/src/coil/**`, `apps/web/src/components/coil/**`, `packages/contracts/src/coil/**` —
  live feature code (update delivery).
- `scripts/coil/**` — fork setup, upstream sync, release manifests, macOS signing.
- `.github/workflows/coil-*.yml` — `coil-upstream-sync.yml`, `coil-weekly-verify.yml`,
  `coil-sync-resolve.yml`, `coil-ci.yml` (the fork's PR/main gate; upstream's `ci.yml` needs
  blacksmith runners the fork cannot use), `coil-release.yml` and `coil-deploy-home.yml`.
- `infra/coil-update-relay/**`, `apps/coil-home/**` — the update relay Worker and the fork's site.
- `docs/coil/**`, `docs/superpowers/specs/**` — including `docs/coil/agents/**` (issue tracker, triage
  labels, domain-doc rules for the mattpocock engineering skills) and `docs/coil/adr/`. These sit
  under `docs/coil/` rather than the skills' default `docs/agents/`, root `CONTEXT.md`, and
  `docs/adr/` precisely because those three are paths upstream could plausibly create.

Note that a fork-created file is only conflict-free if upstream never creates a file at the same
path. Roughly half of the fork's new files sit outside the four `coil`-named namespaces above, so
that guarantee is weaker than it looks.

### Desktop auto-build — retired

`scripts/coil/auto-build-desktop.sh` polled `origin/main` on a 12h cadence, built a dmg locally and
installed it over `/Applications`. Update delivery (#51, #55) superseded it: CI already builds every
green merge to main, signs it with the same identity, and the app offers the restart itself. It cost
zero seams while it existed — it shelled out to `pnpm dist:desktop:dmg:arm64` rather than editing
`scripts/build-desktop-artifact.ts` (hot), and was invoked by path so it added no entry to the root
`package.json` (also hot). Kept here because "why is there no local build loop" is a question the
next reader will have.

## Regenerating

```bash
git fetch origin main upstream                             # both refs must be current
MB=$(git merge-base origin/main upstream/main)             # origin/main, NOT local main
git diff --numstat "$MB"..origin/main | while read -r a d p; do
  git cat-file -e "$MB:$p" 2>/dev/null && printf '%s\t%s\t%s\n' "$a" "$d" "$p"
done
```

`origin/main` is load-bearing, the same way `@<epoch>` is below. A local `main` that has not been
fetched is simply behind now that syncs land as merge commits — but back when they landed by
force-push it **diverged**, and silently: on 2026-08-05 it was 62 behind / 64 ahead, and a
regeneration run through it under-reported the surface by 11 lines while still looking plausible.
Sanity-check with `git rev-list --left-right --count main...origin/main` before trusting a run;
anything non-zero on the left means local `main` is not the fork.

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
