# Parked fork features

Upstream #2829 replaced the orchestration engine (orchestration v2). The fork features below
were built on the deleted v1 engine (`OrchestrationEngine`, `ProjectionSnapshotQuery`,
`ProviderService`, `contracts/orchestration.ts`, the v1 Claude adapter). The 2026-10-08 sync
merged upstream `cdd331b6c3` and parked them here instead of porting them in the same change.

Files keep their original paths under `coil-parked/`, so restoring one is
`git mv coil-parked/<path> <path>`. Nothing here is typechecked, tested, or linted. Treat it as
reference material for a port to v2, not as code that still works. Fork edits to upstream-owned
files were dropped in the merge; recover them from the last pre-sync `main`,
`git show 6ffa75a398:<path>`.

| Feature                                                 | Parked here                                                                                                                                                        | Upstream-file edits dropped (see `6ffa75a398`)                                                                                                | What upstream ships now                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Auto-resume after rate limits                           | `apps/server/src/coil/autoResume`, `apps/web/src/coil` (capsule)                                                                                                   | `server.ts` coil seam, `ThreadRouteView.tsx` overlay mount                                                                                    | Usage-limit recovery: `orchestration-v2/UsageLimitRecoveryWorker.ts`, **Auto-resume limited threads** in **Settings → General** |
| Loops                                                   | `apps/server/src/coil/loop`, `apps/server/src/mcp/toolkits/loop`, `apps/web/src/coil/loop`, `LoopsSettings.tsx`, `routes/settings.loops.tsx`, `docs/user/loops.md` | `ClaudeAdapter.ts` hooks (file deleted upstream; now `orchestration-v2/Adapters/ClaudeAdapterV2.ts`), `McpHttpServer.ts`, settings nav/search | Scheduled tasks (`scheduling/Scheduler.ts`, **Settings → Scheduled Tasks**) overlap in part                                     |
| Web push                                                | `apps/server/src/coil/webPush`, `notifications/push*.ts`, `notifications/serviceWorker.ts`, `PushSubscriptionManager.tsx`, `public/sw.js`                          | `__root.tsx` mount                                                                                                                            | Nothing equivalent                                                                                                              |
| Needs-input notifications                               | `apps/web/src/notifications`, `NotificationCoordinator.tsx`                                                                                                        | `__root.tsx` mount, `SettingsPanels.tsx` toggle                                                                                               | Opt-in **Thread notifications** (#11481) in **Settings → General**                                                              |
| Offline outbox and Queue button                         | `apps/web/src/outbox`, `ThreadOutboxQueueList.tsx`                                                                                                                 | `ChatView.tsx`, `ChatComposer.tsx`, `ComposerPrimaryActions.tsx`, `connection/platform.ts`, `__root.tsx`                                      | v2 queues follow-ups on the server while a run is active; nothing holds sends while disconnected                                |
| Crash-recovery reconciler                               | `apps/server/src/orchestration/Layers/CrashRecoveryReconciler*.ts`                                                                                                 | `serverRuntimeStartup.ts` (+ test)                                                                                                            | `orchestration-v2/ProviderRuntimeRecoveryService.ts` reconciles runs at startup                                                 |
| Slow-backend tolerance and heartbeat (#21, client half) | Not parked; the edits lived only in upstream files                                                                                                                 | `packages/client-runtime/src/connection/supervisor.ts` (+ test)                                                                               | #14897 rewrote reconnect backoff (jittered, keeps healthy sockets); there is no background heartbeat                            |

Still wired but now unused: the `notifyOnNeedsInput` setting in `packages/contracts/src/settings.ts`,
the desktop `showNotification` / `onNotificationActivated` bridge (`ipc.ts`, `preload.ts`,
`ElectronNotification.ts`), and the server's `web-push` dependency.

Before porting a row, check what upstream already covers. Retire the fork version when upstream's
covers the need.
