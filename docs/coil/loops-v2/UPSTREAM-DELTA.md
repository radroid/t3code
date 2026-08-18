# Upstream re-verification — 2026-08-17

Re-measured before writing the implementation plan, because the design docs were written against
merge-base `196c8ea0d` (2026-08-14) and upstream has moved since.

```
merge-base   196c8ea0d  2026-08-14  fix(web): style sidebar action tooltips (#6371)
upstream/main a4cc1367b  2026-08-17  fix(web): show all usage breakdown periods (#7219)
             116 commits, 3 days
origin/main  df027ec08              116 behind upstream — the sync has not landed
```

> **Superseded the same day — the sync landed.** While this was being written, the daily sync
> force-landed onto `main`, putting the fork on merge-base **`a4cc1367b`** — exactly the tree
> everything below was measured against — **0 commits behind upstream**. The merge-base is cited
> throughout rather than a fork `main` SHA, because every sync rewrites `main`. Every
> finding therefore describes the fork's _current_ `main`, not a future one, and every check below
> was re-run against that tree and still passes. Two consequences, both good: the sequencing
> question in §6 is moot, and the seam ledger re-baselined to **53 files, +2590 / −1042**.
> See §6 for what changed and §7 for the re-verification.

**Verdict: the design holds.** Nothing upstream invalidates it, one change strengthens it, and one
change turns an open question into a measured answer. Five things need correcting in the docs, all
minor. Details below, each re-verified by command rather than assumed.

---

## 1. The beachhead is still unclaimed

The whole design rests on these being fork-territory. All re-checked against `upstream/main`:

| Claim                                                                            | Check                                                             | Result                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| `session_crons` / `ScheduleWakeup` / `CronCreate` absent from server + contracts | `git grep -l` over `apps/server/src`, `packages/contracts/src`    | **zero hits**                                 |
| `options.hooks` set nowhere in `ClaudeAdapter`                                   | `git grep -n "hooks:"`                                            | **zero hits**                                 |
| `mcp/toolkits/` has only `preview`                                               | `git ls-tree`                                                     | **still only `preview`**                      |
| No upstream loop/cron/schedule/automation feature landed                         | `git log --oneline` filtered on those words over 116 commits      | **zero matches**                              |
| Upstream **#3638** (`schedule_task` / `delegate_task` MCP tools) has not landed  | `git log --grep=3638` and `git grep schedule_task` at `a4cc1367b` | **both empty** — still not on `upstream/main` |

## 2. Unchanged — the load-bearing files

| File                                                            | Status                   | Why it matters                                                                  |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `ProviderSessionReaper.ts`                                      | **unchanged**            | the `backgroundLiveness != null` skip from #5677 is still the current behaviour |
| `ThreadBackgroundLiveness.ts` (upstream **#5219**, `a2ca89aa1`) | **unchanged**            | still in-memory, still presentation-only — the residue argument stands          |
| `Sidebar.logic.ts`                                              | **unchanged**, zero diff | the static-sort rule is verbatim intact at `:534-537`                           |
| `rightPanelStore.ts`                                            | **unchanged**            | the #112 costing survives                                                       |
| `_chat.$environmentId.$threadId.tsx`                            | **unchanged**            | the delta-zero overlay row is still delta-zero                                  |
| `coil/**`                                                       | untouched                | upstream cannot touch fork-owned files                                          |

Thread pinning survives in full: `pinningSupported`, `isPinned`, `sortable`,
`SortablePinnedRowBag` all present in `upstream/main`'s `Sidebar.tsx` (`:707-712`), and
`thread.pin` / `pinnedAt` still in contracts. **Direction A remains free.**

---

## 3. Changed — and it strengthens the design

### 3.1 `#5127` — pending user-inputs now settle as **empty answers** on session stop

`3b54a2a57 fix(server): settle pending user-input requests when a Claude session stops`

```ts
// stopSessionInternal, ClaudeAdapter.ts
for (const pending of [...context.pendingUserInputs.values()]) {
  yield * pending.cancel; // -> Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers)
}
```

`AskUserQuestion` **still blocks** — `Deferred.await(answersDeferred)` inside the `canUseTool`
interception, per §5 item 1 the anchor rather than a line number — so the core finding is
unchanged. What is new is the teardown path: a question that nobody answers is
now resolved with an **empty answer object** when the session stops, so the thread can settle.

**The agent does not act on the empty answer** — an earlier reading of this commit said it did, and
that was wrong. `settleAsAborted` sets `aborted = true` before succeeding the Deferred with `{}`, so
the handler unparks and then returns `{ behavior: "deny", message: "User cancelled tool execution." }`
to the SDK; the session is being torn down anyway. Nothing continues on a null choice.

**What survives is a projection problem, and it is enough.** The runtime still emits
`user-input.resolved` carrying empty answers, so `hasPendingUserInput` reads false afterwards and a
question that was **voided** is indistinguishable, in the projection, from one a human answered.

Consequences for the plan:

- It **strengthens the case for `raise_blocker`.** A deferred blocker is durable fork-side state; a
  blocking question is in-memory and is discarded on teardown.
- The console **cannot derive its blocking list from `hasPendingUserInput`** — the fork needs its
  own durable record of `user-input.requested`, marked `voided` when the resolution arrives empty
  during teardown rather than from a human.
- Add a test: session stop while a question is pending ⇒ the fork records it as `voided`, not as
  answered. (New cases, added to TESTS.md §7b.)

### 3.2 `#4466` — upstream now disables hooks on capability probes

`db02c6b9c Skip user hooks during Claude capability probes`

```ts
// ClaudeProvider.ts — the probe only
settings: { disableAllHooks: true },
```

Two readings, both useful:

- **Confirms user hooks run in normal sessions.** The commit's own reason is that
  `SessionStart` hooks would otherwise fire on every health check — which only matters because
  hooks _do_ run the rest of the time. That validates the BACKEND §5 claim that a user's
  `~/.claude` hooks apply to a loop turn exactly as to a terminal one.
- **The neighbourhood is now occupied.** `options.hooks` is still unset, but upstream has started
  touching hook-adjacent config. The one-line spread is still available; it is no longer in a part
  of the file nobody visits. Worth re-checking at implementation time, not before.

---

## 4. Changed — and it answers an open question

### 4.1 A new settings section landed, so decision 3 is now priced, not estimated

`949feb61e feat(web): configurable browser defaults in Settings → Integrations (#7082)` added
`/settings/integrations` — a complete worked example of the exact operation the Loops settings
section needs, and it **landed the same day (2026-08-17)** as this re-verification.

What upstream paid, and what the fork would pay:

| File                         | Upstream's delta | Fork's equivalent                                      | Seam cost                      |
| ---------------------------- | ---------------- | ------------------------------------------------------ | ------------------------------ |
| `settingsSearch.ts`          | +26              | union entry + label + 2-3 search items                 | **NEW row** (~+4)              |
| `SettingsSidebarNav.tsx`     | +2               | icon import + record entry                             | **NEW row** (+2)               |
| `routes/settings.<name>.tsx` | +11              | new fork-owned file                                    | **0** — conflicts with nothing |
| `routeTree.gen.ts`           | +21              | regenerates                                            | **0** — generated, not merged  |
| `SettingsPanels.tsx`         | +10              | **avoid** — churn 36, risk 2088                        | **0**                          |
| `contracts/settings.ts`      | +39              | **avoid** — persisted schema, churn 26, the #29 anchor | **0**                          |

**Answer to decision 3: an own settings section costs 2 new seam rows, both small and additive**
(~6 lines total). The fork renders its own panel from its own route and keeps its state in
`coil-loop.json`, so it pays neither of the two expensive rows upstream chose.

**Caveat that did not exist before:** `settingsSearch.ts` has taken **3 commits in 3 days**
(#7082, #7083, #5508). It was a quiet file when the earlier estimate was made; it is now hot, and
its `SETTINGS_SEARCH_ITEMS` array is append-ordered — the same add/add shape as issue #29. The row
is still worth taking, but it will conflict occasionally and the plan should say so.

---

## 5. Corrections needed in the existing docs

Small, and none of them change a decision.

1. **`ClaudeAdapter.ts` line numbers are stale by ~600 lines.** _Partially applied._ The
   _structure_ is unchanged — `canUseTool`, `env`, `additionalDirectories`, the `extraArgs` spread,
   then the `mcpServers` spread — so the one-line hooks spread lands the same way, and the
   `AskUserQuestion` interception is still inside `canUseTool` with its `Deferred.await` below it.
   **Fix: cite the structural anchor — the `queryOptions` object and its `mcpServers` spread — and
   stop citing line numbers in this file at all.** Numbers in a churn-16 file are a liability in a
   document meant to outlive a sync. Some cites elsewhere in the package still carry them.
2. **`Sidebar.tsx` is hotter than recorded** — 7 commits in 3 days, **+184/−81 (265 lines
   touched**: tooltips, PR badges, provider accent badges, an archive-menu restore, a styling
   refactor, and one landed-then-reverted layout change). None touch pinning or partitioning. This
   _reinforces_ rejecting Direction B: a new row there would have collided with something in the
   last 72 hours. _Recorded here; nothing to change elsewhere._
3. **`RightPanelTabs.tsx` moved** (+13, styling only — a `Button` render prop). The #112 answer
   (**2 seam rows**: `rightPanelStore.ts` + `RightPanelTabs.tsx`) is unaffected because
   `rightPanelStore.ts` did not move at all. The measurements #112 asked for, over the 60 days
   before `a4cc1367b`: **`RightPanelTabs.tsx` churn 14, `rightPanelStore.ts` churn 7**, and **there
   is no extension point** — the tab switch is the only way in, so a console tab cannot be mounted
   without editing both. Each row's risk is its projected fork lines × that churn, which is what
   makes a small tab cheap and a large one not.
4. **Add the voided-question failure mode** (§3.1) to the console design and the test list.
   **Done** — BACKEND §9.1b and TESTS §7b.
5. **Re-baseline the docs' merge-base line** from `196c8ea0d` to whatever the next sync lands on,
   at implementation time. _Deferred to implementation, by design._

---

## 6. What this means for sequencing — resolved

This section originally weighed building on a 116-behind `main` against waiting for the sync, and
flagged one real interaction: phase 4's `settingsSearch.ts` row had to be written _after_ the sync
carrying #7082, or it would conflict with the `integrations` entry on the way in.

**The sync landed the same day**, putting `origin/main` on merge-base `a4cc1367b`, zero behind
upstream. So:

- There is nothing to sequence around. Build on `main` as it stands.
- **The #7082 interaction is already satisfied** — `apps/web/src/routes/settings.integrations.tsx`
  is in the fork's tree and `settingsSearch.ts` carries 7 `integrations` references. Phase 4 adds
  its entry _beside_ a row that has already landed, which is the cheap ordering, achieved for free.
- The one thing that did move is the **seam ledger: 51 → 53 files, +2622/−1093 → +2590/−1042**.
  Two rows added, and the line counts fell — upstream absorbed fork work in this range. Phase costs
  in PLAN.md are quoted against 53.

---

## 7. Re-verified against the post-sync tree

Everything in §1–§4 was measured against `upstream/main`. Now that the fork sits on that same
merge-base, each load-bearing claim was re-run against **the fork's own tree** — a stronger check,
because it is the tree the work would actually be built on.

| Claim                                                                   | Result on the post-sync tree                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `session_crons` / `ScheduleWakeup` / `CronCreate` in server + contracts | **0 files**                                                   |
| `options.hooks` set in `ClaudeAdapter`                                  | **0**                                                         |
| `mcp/toolkits/` contents                                                | **`preview` only**                                            |
| the `mcpServers` spread anchor in `queryOptions`                        | **present**                                                   |
| `Sidebar.logic.ts` diff vs upstream                                     | **zero**                                                      |
| overlay row `_chat.$environmentId.$threadId.tsx`                        | **+10 / −6**, as costed                                       |
| `pinnedAt` in contracts                                                 | **present**                                                   |
| two independent scope-auth mirrors (phase 0's debt)                     | **still two** — `autoResume/http.ts:45`, `webPush/http.ts:49` |

No claim in this document changed on the way across.

`origin/main` was **`f6355f06f`** when this table was run. The next daily sync force-rewrote it to
**`94c6328ef`** on 2026-08-18, on the _same_ merge-base `a4cc1367b`; the two extra upstream commits
it carries touch `PendingUserInputCard.tsx` and a web test, so no row above moves. Fork `main` SHAs
are rewritten by every sync — which is exactly why the merge-base is the anchor this package
cites.
