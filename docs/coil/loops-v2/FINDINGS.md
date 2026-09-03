# Loops — research findings (2026-08-15)

Working notes for the consolidated Loops feature (issue #42 + the residue #38 left behind).
Written against merge-base `196c8ea0d` (2026-08-14), not the 2026-08-02 merge-base the archived
design used.

**Citations re-resolved (review pass, 2026-08-19).** This file said only "the current tree" and
left the reader to work out which one. Every code citation below has been re-resolved by symbol
against the package's real merge-base, **`cebac353d`** — the 2026-08-18 sync _moved_ the
merge-base rather than keeping `a4cc1367b`, and put the fork's `main` on `94c6328ef`. Every file
cited here is byte-identical between `cebac353d` and that tree, so the numbers below hold on
both. Cites that drifted are corrected; cites in files that churn fast are replaced by a symbol
anchor, per UPSTREAM-DELTA §5 item 1 — a line number in a hot file is a liability in a document
meant to outlive a sync. Where the research-tree number is still worth knowing it is given
alongside. (`docs/coil/SEAMS.md` records the same superseded merge-base; that is pre-existing on
`main` and a follow-up, not this package's to fix.)

---

## A. What changed under the archived design

`docs/coil/loop/DESIGN.md` is a 4-design / 12-judgement panel result from 2026-08-02. It is
still the best thinking available on the _reactor_, and most of it survives. Three of its
load-bearing premises have moved.

### A1. Upstream shipped pinning — two days after the design froze

```
da6e1a967 2026-08-04 feat(sidebar-v2): thread pinning for sidebar v2 (#5312)
```

`packages/contracts/src/orchestration.ts:403-406` (the `pinnedAt` field):

> A pin overrides the settled/snoozed lifecycle: while `pinnedAt` is set the thread renders
> in the pinned block and never classifies into a shelf.

That comment overstated its own rule, and this file repeated the overstatement. It has since been
**rewritten upstream, and in the other direction**.

> **Corrected 2026-09-02 (issue #125 §D).** `f70eeeeb0` (#7969, 2026-08-23) inverted pin-vs-settle.
> The contract comment now reads _"Settled and snoozed threads remain in their respective shelves
> even when pinned"_, and the sidebar partition is a single `if / else if` chain — **snoozed, then
> settled, then pinned, then active** `[V]` — mirrored verbatim in
> `apps/mobile/src/features/threads/threadListV2.ts`. So the earlier claim here, that a pin
> overrides auto-settle, is **false**: a settled Loop leaves the pinned block, not just a snoozed
> one. What a pin still buys is a pin marker in whichever shelf the thread lands in, plus
> user-arranged order within the pinned block.
>
> **This does not sink D3, and the reason matters.** D3's load-bearing claim was never "pinning
> keeps a Loop visible forever" — it was **"Direction A costs zero rows in `Sidebar.tsx`"**, and
> that is unchanged. What did change is more useful than what was lost: `thread.pin`'s decider case
> emits companion `thread.unsettled` and `thread.unsnoozed` events `[V]` — _"Pinning is a promotion:
> it clears the parked states rather than silently outranking them"_ — so arming a Loop actively
> un-parks it rather than relying on an ordering rule. The cost of that promotion (arming a snoozed
> thread would cancel the snooze; disarming could remove a user's own pin) is priced in BACKEND §7.

Also real today: `thread.pinned` / `thread.unpinned` **events** (`:1070-1071`; the commands that
produce them are `thread.pin` / `thread.unpin`, `:739,749`), a fractional
`pinOrderKey` for user-arranged order, a drag-reorderable pinned block in `Sidebar.tsx`
(`SortablePinnedThreadRow`, `planPinnedReorder`), and the pinned block deliberately renders
with **no header** (`Sidebar.tsx`, the `pinningSupported` prop comment — `:703` today, `:674` on
the research tree).

**Consequence.** #38's proposal 2 — _"a distinct thread type that pins to the top of the
sidebar"_ — is now mostly an upstream feature. The archived design rejected a sidebar rail
at length (§8 "No sidebar section", and the "Ideas deliberately rejected" entry on the
`document.querySelector` portal). Both rejections were correct **and are now moot**: the
thing they were trying to avoid building already exists, and it is reachable through a
contract command rather than a DOM portal.

### A2. `Sidebar.tsx` and `Sidebar.logic.ts` are NOT seam rows

Verified against `docs/coil/SEAMS.md`: neither file appears. The fork does not touch the
sidebar at all today. That cuts both ways —

- Modelling a Loop as **a pinned thread** costs **zero** upstream lines.
- Giving a Loop **distinct rendering** in the sidebar opens a _new_ row in a 3808-line hot
  file (research-tree measurement; 3911 on the post-sync tree), which is the most expensive kind
  of row this fork can take.

This is the single biggest fork in the design space and it is what the prototypes exist to
resolve.

### A3. The settings mount in the design no longer exists

`BetaSettingsPanel.tsx` is gone. Today's settings surface is the `settings.tsx` shell plus
nine `routes/settings.*.tsx` section files, and a closed `SettingsPath` union in
`components/settings/settingsSearch.ts:3-12` that drives both the nav
(`SettingsSidebarNav.tsx`, `SETTINGS_SECTION_ICONS` + `SETTINGS_NAV_ITEMS`, `:46-67`) and
search. The research tree had eight section files and a 7-member union at `:1-8`; upstream
**#7082** added `integrations` in between.

So the design's "+2 lines in a churn-3 file, risk 6" costing is void and has to be redone.
A **new settings section** now costs: the `SettingsPath` union + `SETTINGS_SECTION_LABELS` +
`SETTINGS_SEARCH_ITEMS` + `SETTINGS_SECTION_ICONS` + a new route file + a `routeTree.gen.ts`
regeneration. That is a materially different bill and it is one of the things the prototypes
have to price.

**Priced since (review pass).** UPSTREAM-DELTA §4.1 read the bill off upstream's own
`/settings/integrations` (#7082) and PLAN §6 carries the answer: **2 new seam rows** —
`settingsSearch.ts` (~+13, because each `SETTINGS_SEARCH_ITEMS` entry is a 5–6 line object
literal) and `SettingsSidebarNav.tsx` (+2). The route file is fork-owned and `routeTree.gen.ts`
is regenerated rather than merged, so neither is seam.

---

## B. What upstream already gives us for free

Measured at merge-base `cebac353d`.

| Capability                                                  | Where                                                                   | Use for Loops                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Pinning, pin ordering, pin overrides auto-settle            | `contracts/orchestration.ts:403-406,1070-1071`; `Sidebar.tsx`           | A Loop pins and never sinks — zero seam                                          |
| Background liveness (`working` / `monitoring`)              | `orchestration/ThreadBackgroundLiveness.ts`; `Sidebar.logic.ts:492-497` | The "is it actually alive" signal, provider-agnostic, exact rather than inferred |
| Snooze + wake, with a `Woke` pill                           | `Sidebar.tsx` (`snoozeWakeLabelText`, `wokeAt`, `isWoke`)               | Vocabulary and colour precedent for a scheduled future event                     |
| Settle / unsettle, `settledOverride`                        | `contracts`, `decider.ts`                                               | Terminal-state precedent                                                         |
| Status hues, fixed system-wide                              | `Sidebar.logic.ts:638-727` (`resolveThreadStatusPill`)                  | Loops must reuse, not invent                                                     |
| Activity append with open `kind` + `Schema.Unknown` payload | `contracts/orchestration.ts:341-350`                                    | Timeline breadcrumbs at zero contract cost                                       |
| Fork HTTP routes without touching contracts/ws              | `coil/webPush/http.ts` pattern                                          | The Loops API                                                                    |
| Durable fork store + reactor                                | `coil/autoResume/*` (15 files)                                          | The Loops reactor, verbatim shape                                                |

**The status vocabulary the fork must not fight** — the kinds come from
`resolveSidebarThreadStatus` (`Sidebar.logic.ts:475-497`), the hues from
`resolveThreadStatusPill` in the same file and the top-status pill in `Sidebar.tsx`:
`approval` amber (`Pending Approval`) · `input` indigo (`Awaiting Input`) · `working` sky
(pulse) · `monitoring` sky (no pulse) · `failed` red · `Woke` amber · `Done` emerald.

**A rule the sidebar states outright** (`Sidebar.logic.ts:534-537`, the comment above
`sortThreadsForSidebar`; this file previously cited `:723-727`, which is inside
`resolveThreadStatusPill` — a mis-citation, not drift, since the rule sits at `:534-537` on the
research tree and today's alike):

> Sidebar sort: static creation order, newest thread on top. Activity NEVER reorders the
> list — a row holds its position from open until settled, so the screen only moves at
> lifecycle transitions.

A Loop that floats to the top on activity would break this. A Loop that pins does not —
pinning is a _lifecycle transition_, which the rule explicitly allows. That is the seam
that makes "loops as special threads" idiomatic rather than a violation.

---

## C. Prior art (web + Mobbin)

### C1. The dominant shape: **config tab + run-history tab**

- **Cursor Automations** — `pr-review-automation`, an `Active` toggle at the top, tabs
  `Settings | Run History`, a trigger block (schedule _and_ events), an Instructions
  textarea, a model picker, and a Tools section.
  [screen](https://mobbin.com/screens/cccf8d2f-4e03-4018-8404-fcdd21949f70)
- **Attio Automations** — tabs `Editor | Runs (61)`, a `Live` toggle, an Overview rail with
  _credits consumed / in progress / avg runtime / completed / failed_, and a `Run history`
  list of `Run #61 … #49` each with status dot, credit count and relative time. Hovering a
  run gives status, runtime, triggered-at, completed-at, credits used.
  [screen](https://mobbin.com/screens/d8d6c229-4909-490c-83a1-a84958f82b83)
- **Manus Scheduled tasks** — `Scheduled | Completed` tabs, rows of _title · schedule-at ·
  status toggle_, overflow menu with **Run now / Edit / Delete**.
  [screen](https://mobbin.com/screens/abb206db-33ee-4f1a-ad2e-1e55b4312151)
- **n8n Executions** — flat table: workflow, status (Success/Error/Canceled), started, run
  time, exec id. Error rows tinted rose across the whole row.
  [screen](https://mobbin.com/screens/6947469e-9c8c-4644-8cae-56a1250195da)
- **Modal** — Created / Started / Finished / Startup / Inputs / Status, with `Terminated`
  and `Done` as distinct terminal states.
  [screen](https://mobbin.com/screens/f9956089-a89e-4875-ae9b-5c649a902161)

**Read-across:** every mature recurring-automation product separates _the definition_ from
_the runs_. T3 has no run concept — a Loop's check-ins are just more turns in one
transcript. This is the strongest new idea the research produced: **an iteration ledger**.

### C2. Bounding is always visible, and always has a reset horizon

- **OpenAI Platform** — `$0.09 / $5.00` with a bar and _"Resets in 29 days"_, plus a
  separate **usage alert** row at 100%. [screen](https://mobbin.com/screens/8cf8d3eb-515b-4ff9-b14c-dddcfb207adf)
- **Wise card limits** — `Daily limit — 10 SGD` / _"Refreshes in 6 hours"_ / `10 SGD
remaining`, with `Edit` and `Remove limit`. [screen](https://mobbin.com/screens/63f79444-67f7-4c71-a964-cfee71cad090)
- **GitHub spending limits** — an explicit `Limit spending` vs `Unlimited spending` radio,
  and threshold alerts at 75/90/100%. [screen](https://mobbin.com/screens/51315de0-aa8d-431b-883b-5a1e38561ef9)
- **Coda rule builder** — `When` time-based, Hour/Day/Week/Month, repeat-on day chips, time
  - timezone, and an **`EXPIRATION: Never ends`** field.
    [screen](https://mobbin.com/screens/91c18f06-72a8-4440-81f7-d4ace2d322be)

**Read-across:** the archived design's insistence on a _mandatory, non-bypassable_ budget
(grafted from RUNWAY) matches every product here except that they all also show
**remaining**, not just spent. "2 of 6" is worse than "4 check-ins left, ends 07:00".

### C3. Agent products converge on the same three affordances

From the web sweep — Cursor background agents monitor from a status-bar icon, an Agents
sidebar panel, and a web dashboard; Cursor Automations run on triggers _or_ schedules;
Devin pauses sessions when the budget is reached rather than charging on; Temporal's
long-running answer is **continue-as-new** (same workflow id, new run id, fresh event
history) precisely because unbounded history is the failure mode.

- Monitor from somewhere ambient (status bar / sidebar / dashboard)
- Bound by money or time, and **pause** rather than kill
- Keep the definition stable while the runs churn

Temporal's continue-as-new is worth naming in the report: T3's equivalent problem is a
transcript that grows all night and compacts away its own instructions. The archived design
already anticipated this ("restated **in full on every nudge** because a long overnight run
will compact away anything taught only once").

Sources: [Cursor background agents](https://www.morphllm.com/cursor-background-agents) ·
[Cursor Apr-2026 automations](https://agentmarketcap.ai/blog/2026/04/05/cursor-april-2026-agent-mode-overhaul-background-agents-ide-convergence) ·
[Devin sessions](https://fast.io/resources/devin-session-tools-guide/) ·
[Devin pricing/budget](https://fast.io/resources/devin-ai-pricing/) ·
[Temporal continue-as-new](https://docs.temporal.io/workflow-execution/continue-as-new) ·
[Temporal long-running](https://temporal.io/blog/very-long-running-workflows) ·
[Inngest scheduled jobs](https://www.inngest.com/uses/scheduled-jobs)

---

## D. What carries over from the archived design unchanged

These were verified once and, but for the one correction noted under the first bullet, nothing
since has touched them. They are the spine of the backend and the prototypes assume them.

- **Trigger on `updatedAt` staleness**, not `session.status`. A turn whose completion never
  arrives pins `session.status = "running"` with nothing _automated_ to clear it —
  `ProviderSessionReaper.ts:65` skips any binding whose thread has `session.activeTurnId != null`
  — so gating on it deadlocks exactly the issue-38 threads. The `updatedAt` half was verified
  separately and is unchanged.

  > **Both justifications corrected in review.** This bullet used to read "a background
  > _subagent's_ message auto-opens a synthetic turn … and **nothing** closes it". Neither half
  > holds. Subagent snapshots have not opened synthetic turns since upstream **#5219**
  > (`a2ca89aa1`, 2026-08-06 — nine days before these notes): `handleAssistantMessage` returns
  > early for any assistant snapshot carrying `parent_tool_use_id`, so what auto-opens a
  > synthetic turn is a **top-level** assistant message arriving with no active turn. And four
  > things close one — a later SDK `result` (`handleResultMessage` ends in an unconditional
  > `completeTurn`), the next `sendTurn` (which auto-closes stale synthetic turns, and says
  > so), a stream exit, and `stopSession`. The archived design carried the qualifier and these
  > notes dropped it (`docs/coil/loop/OPTIONS.md:505` — "nothing closes it but a later SDK
  > `result` or the next `sendTurn`"). The field evidence goes with it: #38's 1,358 orphaned
  > activities were read as proof of a stuck synthetic turn, but the fork's own capture
  > (`docs/coil/loop/captures/subagent-backgrounded.ndjson`) shows that post-turn traffic is
  > `system` messages, which never reach `handleAssistantMessage` at all — so treat that
  > attribution as unproven. The conclusion — never gate on `session.status` — survives on the
  > reaper skip alone.

- **Reserve the attempt before dispatch**, so a provider that cannot spawn burns budget
  rather than tight-looping.
- **Terminal vocabulary must distinguish `done` from `spent`.** "It finished" vs "it ran
  out of rope" is the exact thing the user could not tell apart on the night.
- **Human takeover disarms**, it does not reset the budget.
- **Surface the refusals** — a loop that is skipping for a good reason must say so.
- **`worktreePath` first, then `workspaceRoot`**, for every filesystem read.
- **Restate the stop protocol in full on every check-in** — context compaction eats a
  contract taught once.
- **`processStartedAtMs` boot-grace floor**, or every armed thread fires at once after a
  restart.

## E. Open questions the prototypes must answer

1. Is a Loop **a pinned thread with decoration** (zero sidebar seam) or **its own row type**
   (new seam row in a 3808-line — post-sync 3911 — hot file)?
2. Does the loop get **its own surface** (a Loops route listing all loops and their runs) or
   live entirely inside the thread it supervises?
3. Where does the **iteration ledger** render — inline in the transcript as breadcrumbs, in
   the right panel, or as a dedicated tab?
4. Does the settings toggle justify a **new settings section**, or ride inside an existing
   one?

---

## F. Scope as the user restated it (2026-08-15, before handing over for the night)

Verbatim intent, unpacked into requirements. This supersedes the narrower framing above
where they conflict.

### F1. The headline ask — a standing answer to "what do you need from me?"

> _"at any time I open the chat there should be a page where I have a questionnaire ready to
> be answered by the human or the things that are a blocker and the human is needed for"_

This is the centrepiece, and it is **not** what the archived design built. The archived
design's user-facing surface is a _pill_ that reports loop state (`Loop watching · 12m`,
`Loop 2/6 · ends 07:00`). That answers "is it alive". It does not answer **"what is it
stuck on and what do you want from me"**.

Requirement: opening a loop thread lands on a **console**, not a transcript tail. The
console's primary content is a queue of human-answerable items the loop has accumulated —
questions, decisions, blockers — each answerable in place, without reading back through the
night's output.

> **The plan diverges from the first half of this, deliberately (issue #125 §A2).** PLAN §3 decides
> that **the transcript stays the default view and the console is an overlay on the same route**.
> This paragraph and prototype P7's Shape A both read as though the opposite had been decided, and
> the reversal was never declared — that is the contradiction #125 caught, and this note is the
> declaration.
>
> The reason is #38's, restated: an overlay has _"nothing to toggle back from"_. A second default
> view means a sticky per-thread toggle that has to survive reload, agree across two windows, agree
> on mobile, and be discoverable when it is wrong — and landing on a different view means owning the
> thread route's render decision, which is `ChatView.tsx` territory (an existing seam row at churn 83) rather than the delta-zero overlay row.
>
> **The content half of this requirement is met in full.** Everything below — the three sources, the
> degradation property, answering without steering into a live turn — is unchanged. What is given up
> is one interaction: the console is a click away rather than zero, so a human opening the thread
> still sees the night's tail first. If dogfooding shows that tail is what sends people back to
> typing "are you still working on it?", Shape A is the fallback and P7 prices it.

Design consequences to work through in the prototypes:

- **Where do the items come from?** Three candidate sources, in descending order of how
  much they already exist: (a) real pending approvals / pending user input / actionable
  proposed plans — all already SQL-backed columns on `OrchestrationThreadShell`
  (`contracts/orchestration.ts:474-476`, inside the struct that opens at `:448`); (b) the
  loop's own skip reasons, which the archived design already surfaces as `t3x.loop.skipped`
  breadcrumbs; (c) **model-authored questions**, which need a channel that does not exist yet.
- (c) is the interesting one and the risky one. The archived design deliberately **rejected**
  an agent-authored JSON contract (BATON) because "it outsources the hardest judgement to
  the thing that just failed" and "degrades silently". A questionnaire is that idea
  returning through a different door, so the prototype has to answer the degradation
  question: what does the console show when the model writes nothing?
- **Answering must not be a steer into a live turn.** Typing an answer at 9am while a turn
  is running gets absorbed silently. The console needs to either queue answers or show the
  turn boundary honestly.

### F2. Loops as a separate workspace

> _"maybe can be a completely different workspace, which the users can toggle to and back
> into this current view"_

A third structural direction beyond "pinned thread" and "distinct row type": a **mode
switch** where the whole shell becomes loop-oriented — loops list, run ledgers, blocker
queue — and toggles back. Precedent in the product: the settings shell already does exactly
this (its own sidebar nav via `SettingsSidebarNav`, its own routes, a back affordance).
Precedent outside: Cursor's sidebar splits `New Agent / Automations / Dashboard`.

Must be priced like the others. First read: a new top-level route tree is _cheaper_ in seam
terms than decorating `Sidebar.tsx`, because new route files are fork-owned and conflict
with nothing — the cost is `routeTree.gen.ts` regeneration plus whatever entry point flips
the mode.

### F3. Loops × auto-resume × limits

> _"managing and maintaining the loops - working with it and the auto-resume feature.
> Working with loops and running into limits."_

The archived design's §6 is the spine here and it is still right, with the #39 update
applied. What is **not** yet designed is the _user-facing_ half: what the console shows at
2am when the loop is parked inside a 5-hour usage limit, and how that reads differently
from "dead". Two schedulers must never race, and the user must be able to tell "waiting on
Anthropic" from "waiting on you" from "gave up" at a glance.

### F4. Loops as maintainer bots

> _"Working with loops as maintainer bots."_

Ties to open issue #44 (maintainer agent — work a repo's issue queue automatically). The
question for the report is whether a maintainer bot is **the same primitive with a
different prompt and trigger**, or a genuinely different thing. First read: same reactor,
different _stop condition_ and different _source of work_ — a maintainer loop is
goal-sourced from an issue queue rather than from a single thread's unfinished work.

### F5. Deliverable shape

- An explanation for the **backend**.
- A **visual** for the frontend — HTML prototypes, embedded in the report.
- **All angles considered**, with explicit reasoning for why the rejected ones fail.
- If time allows: **the full backend test-case list**.

---

## G. The questionnaire already half-exists — and its other half is the whole problem

Verified at merge-base `cebac353d`. This is the most consequential finding of the night and it
decides the shape of the console.

### G1. Structured questions are a first-class, native concept

`ClaudeAdapter.ts`, `handleAskUserQuestion`, reached from the `canUseTool` callback — cited by
symbol, not by line, per UPSTREAM-DELTA §5 item 1. The numbers are why: the original
`:3758-3860` was a research-tree range around a function that opens at `:3771` there and at
`:3815` today. When the model calls its **`AskUserQuestion`** tool, T3:

1. intercepts it in `canUseTool` (`raw.method: "canUseTool/AskUserQuestion"`),
2. emits a `user-input.requested` runtime event carrying `payload: { questions }`,
3. registers it in `pendingUserInputs`,
4. **blocks**: `const answers = yield* Deferred.await(answersDeferred)`,
5. on answer, emits `user-input.resolved` and unblocks.

The projection turns that into `pendingUserInputCount` → `hasPendingUserInput` on the thread
shell → the indigo **`Awaiting Input`** status in the sidebar. Three sites in
`ProjectionSnapshotQuery.ts` do that mapping (`row.pendingUserInputCount > 0`): `:2054`, `:2199`,
`:2478` today, `:1927,2072,2351` on the research tree.

The question schema is already exactly what a questionnaire needs
(`contracts/providerRuntime.ts`, `UserInputQuestion` at `:450-459` — this file is unmoved since
the research tree):

```ts
UserInputQuestion = { id, header, question, options: [{ label, description }], multiSelect? }
```

So: **structured, multi-question, multi-option human prompts render natively today**, with
no contract change, on every adapter that implements the path.

### G2. …but every one of them halts the run until morning

`AskUserQuestion` is **blocking by construction**. The turn parks on
`Deferred.await(answersDeferred)` until a human answers or the turn aborts.

That is precisely the overnight failure mode the user is trying to escape. An agent that
hits a genuine fork in the road at 01:00 and asks about it correctly **stops working until
09:00** — and it stops for a _good_ reason, which makes it worse: nothing is broken, so no
stall detector should fire, and the archived design's guard #8
(`!hasPendingUserInput` ⇒ skip, keep budget) deliberately refuses to nudge it.

The loop reactor and the question channel are therefore in direct tension:

- Nudge a thread parked on a real question ⇒ you push past the human's decision.
- Don't nudge it ⇒ the night is lost to one question.

### G3. Which means the console needs a _second_, non-blocking channel

The resolution is to stop treating "I need a human" as one thing. It is two:

|                 | **Blocking question**                    | **Deferred blocker**                  |
| --------------- | ---------------------------------------- | ------------------------------------- |
| Raised by       | `AskUserQuestion` (native)               | _does not exist yet_                  |
| Turn behaviour  | parks until answered                     | returns immediately, agent carries on |
| Correct when    | the next step genuinely cannot be chosen | the work can be re-ordered around it  |
| Cost of waiting | the whole night                          | one item on a list                    |

The missing half is a fork-owned tool — call it `raise_blocker` — that records a question
**and returns immediately**, so the agent parks _that thread of work_ and continues with
something else. #42's Phase 2 already sketched exactly the right home for it: a fork-owned
HTTP MCP toolkit, which is provider-agnostic (all five adapters already wire the per-thread
MCP session with its bearer credential — four through an `mcpServers` map, OpenCode through
`client.mcp.add`) rather than Claude-only.

The console then aggregates three sources, and the distinction is the product:

1. **Blocking** — real `hasPendingUserInput` / `hasPendingApprovals` /
   `hasActionableProposedPlan`. _The loop is stopped on these._
2. **Deferred** — `raise_blocker` items. _The loop kept going; answer at leisure._
3. **Loop-authored** — skip reasons and stop reasons (`spent`, `stalled`, rate-limited).
   _Why the loop is not running right now._

### G4. The degradation question, answered

The archived design rejected BATON's agent-authored contract because "it outsources the
hardest judgement to the thing that just failed" and "degrades silently". A questionnaire
is that idea returning through a different door, so it has to answer the same objection.

It does, for one structural reason the BATON design could not claim: **sources 1 and 3
exist whether or not the model cooperates.** Pending approvals, pending inputs, plan-ready
and the loop's own stop reasons are SQL-backed columns and fork-owned state. A model that
never calls `raise_blocker` still produces a useful console — it just shows fewer rows. The
console degrades to "the loop is spent, and nothing is waiting on you", which is true and
useful, rather than to silence.

That is the test the prototypes must visibly pass: **show the empty state**, and make sure
it is still worth opening.
