# Coil fork

`radroid/t3code` tracks `pingdotgg/t3code`, merges upstream every day, and ships its own desktop
build called Coil. Everything here is fork-owned. Everything outside `docs/coil/` is upstream's
unless [`SEAMS.md`](SEAMS.md) lists it.

## What the fork carries

- **Update delivery.** The desktop app gets a "new build" toast from `infra/coil-update-relay`,
  because upstream's updater points at upstream's releases.
- **Its own name and bundle id** (#70, #71), so Coil and upstream's T3 Code can be installed side
  by side.
- **Clone and source-control errors** that name the cause: auth, not found, timeout, and Azure
  DevOps authorization codes.
- **Backend heap headroom** and a **smaller desktop bundle** (`scripts/coil/desktop-file-exclusions.mjs`).

The fork used to carry auto-resume, Loops, needs-input notifications, Web Push, a web offline
outbox, a crash-recovery reconciler and mobile Return-to-send. They were retired in October 2026;
see the notes at the top of [`SEAMS.md`](SEAMS.md).

## Pipelines

| Workflow                 | Runs                                          | Does                                                                                           |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `coil-ci.yml`            | Every PR; pushes to `main` and `coil/sync-**` | Typecheck, lint and tests. The merge gate.                                                     |
| `coil-release.yml`       | After `coil-ci` passes on `main`; manually    | Builds macOS arm64 and Windows x64, publishes a GitHub release, notifies the relay.            |
| `coil-deploy-home.yml`   | Pushes to `main` that touch `apps/coil-home/` | Deploys the download site.                                                                     |
| `coil-upstream-sync.yml` | Daily, 08:00 UTC                              | Merges `upstream/main`. On a conflict or red verify, opens a `coil-sync` issue.                |
| `coil-sync-resolve.yml`  | `@claude resolve` on that issue; manually     | Replays the merge with an agent and opens a sync PR. See the [runbook](sync-agent-runbook.md). |
| `coil-weekly-verify.yml` | Sundays                                       | Full verify of `main`.                                                                         |
| `windows-tests.yml`      | Manually                                      | Upstream's Windows test lane.                                                                  |

A merge to `main` is a release: once CI is green, running Coil apps offer to restart into the new
build.

## Building a feature

1. **Check upstream first.** Search upstream's issues and PRs for the idea. Work that upstream later
   ships is what the 2026-10-14 retirement deleted.
2. **Put code in fork-owned paths.** Use `coil/` directories: `apps/server/src/coil/`,
   `apps/web/src/components/coil/`, `apps/desktop/src/coil/`, `packages/contracts/src/coil/`. A new
   file elsewhere conflicts if upstream ever creates the same path.
3. **Wire it through one aggregator per surface.** The first server feature creates
   `apps/server/src/coil/index.ts` and adds one line each to `server.ts`'s route and application
   layers. Later features register there, not in upstream files.
4. **Keep fork tests in fork files.** Never append cases to an upstream test file; use a sibling
   under `coil/` (issue #29 is why).
5. **Record every upstream edit.** If you must touch an upstream file, add or update its row in
   [`SEAMS.md`](SEAMS.md), with the header totals, in the same commit.
6. **Open a PR into `main`.** `coil-ci` must pass. Run tests locally on Node 24, which
   `package.json` requires; Node 26 fails a `packages/shared` test.

## Staying in sync

The daily job merges upstream on its own, rebuilding the lockfile itself when that is the only
conflict. When it can't, follow the
[sync runbook](sync-agent-runbook.md). Land every sync PR as a **merge commit**, never a squash, or
the same upstream range comes back the next day.
