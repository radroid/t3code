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
> throughout rather than a fork `main` SHA, because every sync rewrote `main` until the 2026-09-02 switch to merge-based syncs (PR #132); anchoring on the merge-base still holds, because that is what the seam ledger measures against. Every
> finding therefore describes the fork's _current_ `main`, not a future one, and every check below
> was re-run against that tree and still passes. Two consequences, both good: the sequencing
> question in §6 is moot, and the seam ledger re-baselined to **53 files, +2590 / −1042**.
> See §6 for what changed and §7 for the re-verification.
>
> **And moved again on 2026-08-18 — corrected by review.** This document originally said the next
> daily sync held the _same_ merge-base. It did not: the base advanced to **`cebac353d`**, which is
> the baseline this package cites from here on, and the one the `53 files, +2590 / −1042` ledger
> figure is measured against. §7 carries the evidence and the single number it changes.

**Verdict: the design holds.** Nothing upstream invalidates it, one change strengthens it, and one
change turns an open question into a measured answer. Six things need correcting in the docs — five
minor, plus one (§3.3) that landed before this window and re-anchors a finding's evidence. Details
below, each re-verified by command rather than assumed.

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

### 3.3 `#5219` — the subagent → synthetic-turn path was already gone

Not a change in this 116-commit window. `a2ca89aa1` landed 2026-08-06, **nine days before these
design docs were written**, and re-verification caught the package still describing the world before
it.

Decision **D2** in PLAN — and the matching carried-over item in FINDINGS §D — justified "never gate
on `session.status`" partly on _a background subagent's_ message auto-opening a synthetic turn. That
has been false since #5219. The only synthetic-turn creation site sits inside
`handleAssistantMessage`, and #5219 added a guard that returns first for any assistant snapshot
carrying `parent_tool_use_id` — its own comment names the behaviour it removed, subagent-owned
snapshots having "spawned synthetic turns per subagent completion". The package cites #5219 in §2
for the liveness map and missed it here.

**D2's conclusion survives; its evidence was re-anchored by review.** What still holds is the reaper
half: `ProviderSessionReaper.ts` skips any binding whose thread has `session.activeTurnId != null`,
so a turn whose completion never arrives pins `running` with nothing automated to clear it. The
package overstated that too — it said _nothing_ closes a synthetic turn, where the archived design
was careful (`docs/coil/loop/OPTIONS.md:505`: "nothing closes it but a later SDK `result` or the
next `sendTurn`"). Four closers exist and one is unconditional: `handleResultMessage` ends in a bare
`completeTurn` with no `synthetic` check, `sendTurn` auto-closes stale synthetic turns, and
`handleStreamExit` and `stopSessionInternal` close on teardown. So the accurate claim is that
_nothing automated_ clears it — only a later `result`, the user's next message, or process exit.
The opener that survives is a **top-level** assistant message with no `parent_tool_use_id` arriving
with no active turn; "subagent" is gone from that sentence, the qualifier is restored, and the #38
orphaned-activity count no longer stands as `[V]` evidence for it. The `updatedAt` half of the
trigger was independently verified and is untouched.

This also resolves an internal contradiction: BACKEND §1.1 says T3 auto-starts a synthetic turn for
assistant messages arriving without one, while §4 said a synthetic turn pins `running` and nothing
closes it. Both cannot hold. With the correction they do — the wake's own `result` closes the
synthetic turn, which is exactly what makes a deferred wake observable in the thread.

---

## 4. Changed — and it answers an open question

### 4.1 A new settings section landed, so decision 3 is now priced, not estimated

`949feb61e feat(web): configurable browser defaults in Settings → Integrations (#7082)` added
`/settings/integrations` — a complete worked example of the exact operation the Loops settings
section needs, and it **landed the same day (2026-08-17)** as this re-verification.

What upstream paid, and what the fork would pay:

| File                         | Upstream's delta | Fork's equivalent                                      | Seam cost                      |
| ---------------------------- | ---------------- | ------------------------------------------------------ | ------------------------------ |
| `settingsSearch.ts`          | +26              | union entry + label + 2 search items                   | **NEW row** (~+13)             |
| `SettingsSidebarNav.tsx`     | +2               | icon import + record entry                             | **NEW row** (+2)               |
| `routes/settings.<name>.tsx` | +11              | new fork-owned file                                    | **0** — conflicts with nothing |
| `routeTree.gen.ts`           | +21              | regenerates                                            | **0** — generated, not merged  |
| `SettingsPanels.tsx`         | +10              | **avoid** — churn 36, risk 2088                        | **0**                          |
| `contracts/settings.ts`      | +39              | **avoid** — persisted schema, churn 26, the #29 anchor | **0**                          |

**Answer to decision 3: an own settings section costs 2 new seam rows, both additive** (~+15 lines
total). The fork renders its own panel from its own route and keeps its state in `coil-loop.json`,
so it pays neither of the two expensive rows upstream chose.

**The two delta columns are not comparable as written — corrected by review.** The
`settingsSearch.ts` cost was `~+4` here, sitting in a column opposite upstream's measured `+26` for
the same operation, which was never plausible. Upstream's +26 decomposes as 1 union member + 1 label
entry + 4 search items, and each `SETTINGS_SEARCH_ITEMS` entry is a 5–6 line object literal (37
items span 202 lines). Apply this document's own recipe — union member, label entry, two search
items, written in the file's existing style — to the real file and diff it, and it measures **+13**.
A third search item costs about +6 more. The **row count is unchanged**, which is what decision 3
turns on; only the line count moves, and it moves by 3×.

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
   **Amended by review: those two are the registration points, not the whole edit.** Both switches
   render the tab _chrome_. The body is chosen separately, by `rightPanelContent`'s kind ternary in
   `ChatView.tsx` — a third edit site, mandatory by default, and an **existing** seam row at churn
   83 / risk 18094, by a wide margin the most expensive file in this neighbourhood. Staying at
   **2 rows** therefore means not touching it: the console has to arrive through the tab's
   `children` rather than through that ternary. The 2-row answer holds, but only with that
   constraint stated out loud.
4. **Add the voided-question failure mode** (§3.1) to the console design and the test list.
   **Done** — BACKEND §9.1b and TESTS §7b.
5. **Re-baseline the docs' merge-base line** from `196c8ea0d` to whatever the next sync lands on,
   at implementation time. _No longer deferred — two syncs have landed since this was written and
   the value to re-baseline onto is **`cebac353d`** (§7)._
6. **Drop "subagent" from D2's evidence** — #5219 retired that path before these docs were
   written, and the "nothing closes a synthetic turn" claim needs its qualifier back. **Done** —
   §3.3 has the mechanism; D2 keeps its conclusion on the reaper evidence alone.

---

## 6. What this means for sequencing — resolved

This section originally weighed building on a 116-behind `main` against waiting for the sync, and
flagged one real interaction: phase 4's `settingsSearch.ts` row had to be written _after_ the sync
carrying #7082, or it would conflict with the `integrations` entry on the way in.

**The sync landed the same day**, putting `origin/main` on merge-base `a4cc1367b`, zero behind
upstream — and the next day's sync carried the base forward to `cebac353d` (§7). So:

- There is nothing to sequence around. Build on `main` as it stands.
- **The #7082 interaction is already satisfied** — `apps/web/src/routes/settings.integrations.tsx`
  is in the fork's tree and `settingsSearch.ts` carries 7 `integrations` references. Phase 4 adds
  its entry _beside_ a row that has already landed, which is the cheap ordering, achieved for free.
- The one thing that did move is the **seam ledger: 51 → 53 files, +2622/−1093 → +2590/−1042**.
  Two rows added, and the line counts fell — upstream absorbed fork work in this range. Phase costs
  in PLAN.md are quoted against 53. That headline is measured against **`cebac353d`**; §7 says what
  it reads against `a4cc1367b` and why the difference is not fork work.

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
**`94c6328ef`** on 2026-08-18. Fork `main` SHAs were rewritten by every sync until the 2026-09-02
switch to merge-based syncs (PR #132) — which is why the merge-base is the anchor this package
cites, and it still is: the seam ledger measures against it either way.

**Retracted: that sync did not hold the merge-base.** This paragraph said `94c6328ef` sat on the
_same_ base `a4cc1367b`, with two extra upstream commits riding along. The base **moved**, and the
baseline this package cites is **`cebac353d`**. Two commands settle it:
`git log --oneline a4cc1367b..94c6328ef | tail -2` puts two _upstream_ commits underneath the fork's
replayed stack — `3723722f7` (`test(web)`, #7364) and `cebac353d` (`fix(mobile)`, #7321) — and
`gh api repos/pingdotgg/t3code/compare/cebac353d...main` returns `behind: 0`, so `cebac353d` is an
upstream ancestor and therefore the merge-base.

It changes one number, and it is the package's headline. The seam ledger **53 files, +2590 / −1042**
is only true against `cebac353d`; the same recipe against `a4cc1367b` reads **55 files,
+2611 / −1055**, because two of upstream's own edits get counted as the fork's. Nothing else moves:
the table above is unaffected — those two commits touch `PendingUserInputCard.tsx` and a web test —
and §1–§5 were measured against upstream `a4cc1367b`, which those same two commits do not disturb
either. Where an earlier section names a measurement window against `a4cc1367b`, that is the tree it
was run on and stays as written.

**Follow-up, not this package's to fix:** `docs/coil/SEAMS.md` on `origin/main` states the same
stale merge-base in its header — "against merge-base `a4cc1367b` (the 2026-08-17 sync)". That
defect predates this PR, in a file this PR does not touch, so it belongs to the next ledger
re-baseline rather than here. The figures agree either way; only the base they are attributed to is
wrong there.

---

## 8. Verified against the shipped binary, not the tree — `[V - external]`

Everything above is a statement about a git tree. The two facts here are not: they were checked by
running commands against the **shipped dependency** — `@anthropic-ai/claude-agent-sdk@0.3.170`, the
version `apps/server/package.json` pins, and the `claude` binary it drives (2.1.236). They carry the
`[V - external]` marker defined in BACKEND's marker discipline: as strong as `[V]` on the day it was
run, but able to change under the fork with **no repo diff** to warn anyone, so a version bump
re-opens them. The same marker now carries the `ScheduleWakeup` `[60, 3600]` clamp and the
scheduler's jitter text used elsewhere in this package.

### 8.1 `session_crons` hook delivery is no longer an assumption

The package's largest `[A]` was that the `Stop` hook's payload actually carries `session_crons` —
a hook whose delivery was assumed, holding up the deference rule. It does carry it. In the binary,
`{background_tasks, session_crons}` is spread **unconditionally** into both the `Stop` and
`SubagentStop` hook inputs, and the builder maps each recorded task to
`{id, schedule: t.cron, recurring: t.recurring ?? false, prompt}`. With no crons recorded the field
is `[]` — never absent — so "field missing" is not a case the reactor has to handle, and the shape
matches what BACKEND documents. **Promote that assumption from `[A]` to `[V - external]`.**

Note what `schedule` is: the cron **expression**, not a next-fire timestamp. Turning it into a time
is fork-side work, which is why the deference rule owns a parse.

### 8.2 New — the delivered `prompt` is truncated to 1000 characters

Undocumented anywhere in this package until now: the binary truncates each entry's `prompt` to
**1000 characters** before handing it to the hook. Any design or test that assumes the fork receives
the agent's full prompt text is wrong — it receives a prefix. Harmless for the `id`, `schedule` and
`recurring` fields the deference rule reads; not harmless for anything that wants to match on prompt
content, hash it, or round-trip it back into a turn.

---

## 9. Second re-verification — 2026-09-02 (issue #125 §D)

Two syncs have landed since §7. The merge-base moved `cebac353d` → **`941acb4f9`** (the 2026-09-02
sync, 182 upstream commits, issue #128), and the seam ledger re-baselined to **53 files,
+2609 / −981** — the same 53 files, so no row was added or retired by the sync itself.

### 9.1 Both facts #125 flagged as stale are confirmed, and both are now in the fork's tree

| Change                                                                                                                                                                                                                                                                                                                             | Effect on this package                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`f70eeeeb0` (#7969, 2026-08-23) inverted pin-vs-settle.** The contract now reads _"Settled and snoozed threads remain in their respective shelves even when pinned"_, and the sidebar partition is a single chain: **snoozed → settled → pinned → active** `[V]`, mirrored in `apps/mobile/src/features/threads/threadListV2.ts` | **D3 survives, with lower confidence.** Loop-as-pinned-thread no longer keeps a _settled_ loop visible. But D3's load-bearing claim was the **zero row count** in `Sidebar.tsx`, not the visibility, and that is untouched. FINDINGS §A1 and PLAN D3 corrected                                                                                                            |
| **`c7222ca4d` (#8144, 2026-08-25) added a second blocking dialog.** `onUserDialog` with `supportedDialogKinds: ["resume_return"]` sits in the _same_ `queryOptions` object phase 1 edits, routes into the same blocking `Deferred` as `AskUserQuestion`, and fires on **session resume** `[V]`                                     | **A real new failure mode**: the loop's own nudge, landing on a torn-down session, can manufacture a pending user-input that guard 8 then treats as a hard skip — the loop causes the thing that parks it. No new guard; the fork's `user-input.requested` record carries the dialog kind so the console can name it, and the deadline ends it. BACKEND §9.1c, TESTS 118h |

### 9.2 Churn has moved a lot, and it moved the plan's conclusions

Re-measured with the SEAMS.md recipe against `941acb4f9`. #125 was right that the figures only
reproduced against the older base; they now reproduce against the stated one.

| File                                        | Churn then | Churn now | Consequence                                                          |
| ------------------------------------------- | ---------- | --------- | -------------------------------------------------------------------- |
| `provider/Layers/ClaudeAdapter.ts`          | 16         | **23**    | Phase 1's row is dearer but still one additive line — risk 23        |
| `settings/settingsSearch.ts`                | 14         | **24**    | Phase 4 is now **the most expensive phase in the plan** at ~312 risk |
| `settings/SettingsSidebarNav.tsx`           | —          | **19**    | ~38 risk; both settings rows are type-forced, not optional           |
| `routes/_chat.$environmentId.$threadId.tsx` | 4          | **2**     | Phase 3's row is _cheaper_ than recorded — risk 32, delta still zero |
| `mcp/McpHttpServer.ts`                      | 6          | **2**     | Phase 5 is one row at risk **6**                                     |
| `mcp/McpSessionRegistry.ts`                 | 7          | **1**     | not taken — see §9.3                                                 |
| `mcp/McpInvocationContext.ts`               | 3          | **1**     | not taken — see §9.3                                                 |
| `settings/SettingsPanels.tsx`               | 36         | **43**    | still avoided; ~2900 risk if it were not                             |
| `contracts/settings.ts`                     | 26         | **38**    | still avoided; D12                                                   |

**The inversion is the finding.** The plan was written expecting phase 5 (agent-facing MCP tools)
to be the expensive, scary one and phase 4 (a settings entry) to be routine. Measured, it is the
other way round: the `mcp/` neighbourhood is the quietest in the plan, and the **navigation entry
carries ~350 of the feature's ~411 total risk**.

### 9.3 Phase 5's seam cost, measured rather than estimated

PLAN carried `0–3 rows [A]`; the archived design guessed three files. Three paths exist:

- **Path A — a gated `"loop"` capability: 4 rows, risk 16. Rejected.** `McpCapability` is backed by
  a runtime `Schema.Literal("preview")` in `packages/contracts/src/previewAutomation.ts`, so
  widening the union is a **contracts edit** (breaking D12), and it would make `raise_blocker` fail
  with an error class named `PreviewAutomationUnavailableError`. It buys nothing: nothing at
  registration or dispatch consults `capabilities` — `requireMcpCapability` is one voluntary line
  inside one handler helper — and the MCP credential is already per-thread and already
  all-or-nothing `[V]`.
- **Path B — an ungated toolkit: 1 row (`McpHttpServer.ts` `+2/−1`, churn 2, risk 6). The decision.**
- **Path C — register from `coil/index.ts`: 0 rows. Worth one attempt, not typechecked.**
  `McpServer.toolkit(t)` and `layerHttp` provide the same `McpServer` layer value, so Effect's
  MemoMap should hand both the one instance — the property `coil/index.ts` already relies on. The
  blocker is typed, not behavioural: a declared `McpInvocationContext` dependency leaks into the
  layer's `R`. Upstream's own `registerPreviewSnapshot` shows the way out (`Effect.withFiber` +
  `Context.getUnsafe`). Take Path B the moment it fights back; the difference is one row at risk 6.

**A coupling phase 5 inherits and cannot fix:** the MCP credential is minted only when
`enableAgentBrowserAccess` is true `[V]`, so turning **Settings → Integrations → Agent browser
access** off silently removes `raise_blocker`, `loop_status` and `loop_done`. TESTS 118g.

### 9.4 `5b7d72aad` (#9167) — upstream continues active threads across a restart

Arriving on the next sync, and the closest upstream has come to this feature's territory. It does
**not** take D1's premise away, for four reasons, each from the commit `[V]`:

1. It marks only threads with `session.status === "running" && activeTurnId !== null`. **A thread
   waiting on a scheduled wake is neither, so a pending wake is never marked and never continued** —
   which is exactly the gap this feature covers.
2. It is opt-in and ships **off** (`continueThreadsAfterServerUpdate` decodes to `false`).
3. It writes its marker only on the **intentional self-update** path. A crash, an OOM, a `kill` or a
   machine reboot — the cases a supervisor is for — behave exactly as before.
4. It does not continue the interrupted turn; `activeTurnId` is nulled and a fresh turn is started.

It does introduce a **double-fire window**: reconciliation dispatches `status: "starting",
activeTurnId: null` synchronously at startup while the `sendTurn` waits on server activation, so a
continued thread looks idle for a real interval with no error and no lease. This design already
covers it twice over — `busyTurn` counts `"starting"` (so the fuse is `busyIdleMs`) and
`processStartedAtMs` floors the idle clock at process start — and **neither mechanism was added for
this**. BACKEND §12; TESTS 130b.

### 9.5 Everything else re-checked, and still true

| Claim                                                                   | Result at `941acb4f9`                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `session_crons` / `ScheduleWakeup` / `CronCreate` in server + contracts | **0 files**                                                                                               |
| `options.hooks` set in `ClaudeAdapter`                                  | **0** — the beachhead is still unclaimed                                                                  |
| `mcp/toolkits/` contents                                                | **`preview` only**                                                                                        |
| the `mcpServers` spread anchor in `queryOptions`                        | **present**, and `onUserDialog` now sits beside it                                                        |
| `pinnedAt` / `thread.pin` / `thread.unpin` in contracts                 | **present**                                                                                               |
| an actor check on `thread.pin`                                          | **none** — commands carry no actor; the decider guards on archival alone                                  |
| a cron parser dependency anywhere in the repo                           | **none** — `git grep -i cron -- '*package.json'` and a `cron` search over `pnpm-lock.yaml` are both empty |
| two independent scope-auth mirrors (phase 0's debt)                     | **still two** — and they are no longer equivalent, see below                                              |

**One correction to phase 0's brief.** The webPush helper is _not_ strictly more general than the
autoResume one. It is parameterised on scope and returns the session, which autoResume's is not —
but it calls `failEnvironmentAuthInvalid` with **one** argument where autoResume's passes
`EnvironmentAuth.serverAuthDpopFailureReason(error)` as the second. That argument is `3bdf109e2`
(2026-09-02), which landed precisely because the stale one-argument call compiled and drifted
silently. Promoting webPush's body verbatim would re-introduce that bug in a shared helper, for all
three callers. Promote the **union**: parameterised, session-returning, and DPoP-reporting.
