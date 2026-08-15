# Loops — research findings (2026-08-15)

Working notes for the consolidated Loops feature (issue #42 + the residue #38 left behind).
Everything here is measured against the current tree, not the 2026-08-02 merge-base the
archived design used.

---

## A. What changed under the archived design

`docs/coil/loop/DESIGN.md` is a 4-design / 12-judgement panel result from 2026-08-02. It is
still the best thinking available on the *reactor*, and most of it survives. Three of its
load-bearing premises have moved.

### A1. Upstream shipped pinning — two days after the design froze

```
da6e1a967 2026-08-04 feat(sidebar-v2): thread pinning for sidebar v2 (#5312)
```

`packages/contracts/src/orchestration.ts:389-393`:

> A pin overrides the settled/snoozed lifecycle: while `pinnedAt` is set the thread renders
> in the pinned block and never classifies into a shelf.

Also real today: `thread.pinned` / `thread.unpinned` commands (`:1056-1057`), a fractional
`pinOrderKey` for user-arranged order, a drag-reorderable pinned block in `Sidebar.tsx`
(`SortablePinnedThreadRow`, `planPinnedReorder`), and the pinned block deliberately renders
with **no header** (`Sidebar.tsx:674`).

**Consequence.** #38's proposal 2 — *"a distinct thread type that pins to the top of the
sidebar"* — is now mostly an upstream feature. The archived design rejected a sidebar rail
at length (§8 "No sidebar section", and the "Ideas deliberately rejected" entry on the
`document.querySelector` portal). Both rejections were correct **and are now moot**: the
thing they were trying to avoid building already exists, and it is reachable through a
contract command rather than a DOM portal.

### A2. `Sidebar.tsx` and `Sidebar.logic.ts` are NOT seam rows

Verified against `docs/coil/SEAMS.md`: neither file appears. The fork does not touch the
sidebar at all today. That cuts both ways —

- Modelling a Loop as **a pinned thread** costs **zero** upstream lines.
- Giving a Loop **distinct rendering** in the sidebar opens a *new* row in a 3808-line hot
  file, which is the most expensive kind of row this fork can take.

This is the single biggest fork in the design space and it is what the prototypes exist to
resolve.

### A3. The settings mount in the design no longer exists

`BetaSettingsPanel.tsx` is gone. Today's settings surface is 7 route files
(`settings.{general,appearance,keybindings,providers,source-control,connections,archived}.tsx`)
plus a closed `SettingsPath` union in `settings/settingsSearch.ts:1-8` that drives both the
nav (`SettingsSidebarNav.tsx:44-64`) and search.

So the design's "+2 lines in a churn-3 file, risk 6" costing is void and has to be redone.
A **new settings section** now costs: the `SettingsPath` union + `SETTINGS_SECTION_LABELS` +
`SETTINGS_SECTION_ICONS` + a new route file + a `routeTree.gen.ts` regeneration. That is a
materially different bill and it is one of the things the prototypes have to price.

---

## B. What upstream already gives us for free

Measured in the current tree.

| Capability | Where | Use for Loops |
|---|---|---|
| Pinning, pin ordering, pin overrides lifecycle | `contracts/orchestration.ts:389-393,1056-1057`; `Sidebar.tsx` | A Loop pins and never sinks — zero seam |
| Background liveness (`working` / `monitoring`) | `orchestration/ThreadBackgroundLiveness.ts`; `Sidebar.logic.ts:492-497` | The "is it actually alive" signal, provider-agnostic, exact rather than inferred |
| Snooze + wake, with a `Woke` pill | `Sidebar.tsx` (`snoozeWakeLabelText`, `wokeAt`, `isWoke`) | Vocabulary and colour precedent for a scheduled future event |
| Settle / unsettle, `settledOverride` | `contracts`, `decider.ts` | Terminal-state precedent |
| Status hues, fixed system-wide | `Sidebar.logic.ts:640-725` | Loops must reuse, not invent |
| Activity append with open `kind` + `Schema.Unknown` payload | `contracts/orchestration.ts:315-325` | Timeline breadcrumbs at zero contract cost |
| Fork HTTP routes without touching contracts/ws | `coil/webPush/http.ts` pattern | The Loops API |
| Durable fork store + reactor | `coil/autoResume/*` (15 files) | The Loops reactor, verbatim shape |

**The status vocabulary the fork must not fight** (`Sidebar.logic.ts`):
`approval` amber · `input` indigo · `working` sky (pulse) · `monitoring` sky (no pulse) ·
`failed` red · `Woke` amber · `Done` emerald.

**A rule the sidebar states outright** (`Sidebar.logic.ts:723-727`):

> Sidebar sort: static creation order, newest thread on top. Activity NEVER reorders the
> list — a row holds its position from open until settled, so the screen only moves at
> lifecycle transitions.

A Loop that floats to the top on activity would break this. A Loop that pins does not —
pinning is a *lifecycle transition*, which the rule explicitly allows. That is the seam
that makes "loops as special threads" idiomatic rather than a violation.

---

## C. Prior art (web + Mobbin)

### C1. The dominant shape: **config tab + run-history tab**

- **Cursor Automations** — `pr-review-automation`, an `Active` toggle at the top, tabs
  `Settings | Run History`, a trigger block (schedule *and* events), an Instructions
  textarea, a model picker, and a Tools section.
  [screen](https://mobbin.com/screens/cccf8d2f-4e03-4018-8404-fcdd21949f70)
- **Attio Automations** — tabs `Editor | Runs (61)`, a `Live` toggle, an Overview rail with
  *credits consumed / in progress / avg runtime / completed / failed*, and a `Run history`
  list of `Run #61 … #49` each with status dot, credit count and relative time. Hovering a
  run gives status, runtime, triggered-at, completed-at, credits used.
  [screen](https://mobbin.com/screens/d8d6c229-4909-490c-83a1-a84958f82b83)
- **Manus Scheduled tasks** — `Scheduled | Completed` tabs, rows of *title · schedule-at ·
  status toggle*, overflow menu with **Run now / Edit / Delete**.
  [screen](https://mobbin.com/screens/abb206db-33ee-4f1a-ad2e-1e55b4312151)
- **n8n Executions** — flat table: workflow, status (Success/Error/Canceled), started, run
  time, exec id. Error rows tinted rose across the whole row.
  [screen](https://mobbin.com/screens/6947469e-9c8c-4644-8cae-56a1250195da)
- **Modal** — Created / Started / Finished / Startup / Inputs / Status, with `Terminated`
  and `Done` as distinct terminal states.
  [screen](https://mobbin.com/screens/f9956089-a89e-4875-ae9b-5c649a902161)

**Read-across:** every mature recurring-automation product separates *the definition* from
*the runs*. T3 has no run concept — a Loop's check-ins are just more turns in one
transcript. This is the strongest new idea the research produced: **an iteration ledger**.

### C2. Bounding is always visible, and always has a reset horizon

- **OpenAI Platform** — `$0.09 / $5.00` with a bar and *"Resets in 29 days"*, plus a
  separate **usage alert** row at 100%. [screen](https://mobbin.com/screens/8cf8d3eb-515b-4ff9-b14c-dddcfb207adf)
- **Wise card limits** — `Daily limit — 10 SGD` / *"Refreshes in 6 hours"* / `10 SGD
  remaining`, with `Edit` and `Remove limit`. [screen](https://mobbin.com/screens/63f79444-67f7-4c71-a964-cfee71cad090)
- **GitHub spending limits** — an explicit `Limit spending` vs `Unlimited spending` radio,
  and threshold alerts at 75/90/100%. [screen](https://mobbin.com/screens/51315de0-aa8d-431b-883b-5a1e38561ef9)
- **Coda rule builder** — `When` time-based, Hour/Day/Week/Month, repeat-on day chips, time
  + timezone, and an **`EXPIRATION: Never ends`** field.
  [screen](https://mobbin.com/screens/91c18f06-72a8-4440-81f7-d4ace2d322be)

**Read-across:** the archived design's insistence on a *mandatory, non-bypassable* budget
(grafted from RUNWAY) matches every product here except that they all also show
**remaining**, not just spent. "2 of 6" is worse than "4 check-ins left, ends 07:00".

### C3. Agent products converge on the same three affordances

From the web sweep — Cursor background agents monitor from a status-bar icon, an Agents
sidebar panel, and a web dashboard; Cursor Automations run on triggers *or* schedules;
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

These were verified once and nothing since has touched them. They are the spine of the
backend and the prototypes assume them.

- **Trigger on `updatedAt` staleness**, not `session.status`. A background subagent's
  message auto-opens a synthetic turn that pins `session.status = "running"` and nothing
  closes it, so gating on it deadlocks exactly the issue-38 threads.
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
   (new seam row in a 3808-line hot file)?
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

> *"at any time I open the chat there should be a page where I have a questionnaire ready to
> be answered by the human or the things that are a blocker and the human is needed for"*

This is the centrepiece, and it is **not** what the archived design built. The archived
design's user-facing surface is a *pill* that reports loop state (`Loop watching · 12m`,
`Loop 2/6 · ends 07:00`). That answers "is it alive". It does not answer **"what is it
stuck on and what do you want from me"**.

Requirement: opening a loop thread lands on a **console**, not a transcript tail. The
console's primary content is a queue of human-answerable items the loop has accumulated —
questions, decisions, blockers — each answerable in place, without reading back through the
night's output.

Design consequences to work through in the prototypes:

- **Where do the items come from?** Three candidate sources, in descending order of how
  much they already exist: (a) real pending approvals / pending user input / actionable
  proposed plans — all already SQL-backed columns on `OrchestrationThreadShell`
  (`contracts/orchestration.ts:432-436`); (b) the loop's own skip reasons, which the
  archived design already surfaces as `t3x.loop.skipped` breadcrumbs; (c) **model-authored
  questions**, which need a channel that does not exist yet.
- (c) is the interesting one and the risky one. The archived design deliberately **rejected**
  an agent-authored JSON contract (BATON) because "it outsources the hardest judgement to
  the thing that just failed" and "degrades silently". A questionnaire is that idea
  returning through a different door, so the prototype has to answer the degradation
  question: what does the console show when the model writes nothing?
- **Answering must not be a steer into a live turn.** Typing an answer at 9am while a turn
  is running gets absorbed silently. The console needs to either queue answers or show the
  turn boundary honestly.

### F2. Loops as a separate workspace

> *"maybe can be a completely different workspace, which the users can toggle to and back
> into this current view"*

A third structural direction beyond "pinned thread" and "distinct row type": a **mode
switch** where the whole shell becomes loop-oriented — loops list, run ledgers, blocker
queue — and toggles back. Precedent in the product: the settings shell already does exactly
this (its own sidebar nav via `SettingsSidebarNav`, its own routes, a back affordance).
Precedent outside: Cursor's sidebar splits `New Agent / Automations / Dashboard`.

Must be priced like the others. First read: a new top-level route tree is *cheaper* in seam
terms than decorating `Sidebar.tsx`, because new route files are fork-owned and conflict
with nothing — the cost is `routeTree.gen.ts` regeneration plus whatever entry point flips
the mode.

### F3. Loops × auto-resume × limits

> *"managing and maintaining the loops - working with it and the auto-resume feature.
> Working with loops and running into limits."*

The archived design's §6 is the spine here and it is still right, with the #39 update
applied. What is **not** yet designed is the *user-facing* half: what the console shows at
2am when the loop is parked inside a 5-hour usage limit, and how that reads differently
from "dead". Two schedulers must never race, and the user must be able to tell "waiting on
Anthropic" from "waiting on you" from "gave up" at a glance.

### F4. Loops as maintainer bots

> *"Working with loops as maintainer bots."*

Ties to open issue #44 (maintainer agent — work a repo's issue queue automatically). The
question for the report is whether a maintainer bot is **the same primitive with a
different prompt and trigger**, or a genuinely different thing. First read: same reactor,
different *stop condition* and different *source of work* — a maintainer loop is
goal-sourced from an issue queue rather than from a single thread's unfinished work.

---

## G. The questionnaire already half-exists — and its other half is the whole problem

Verified in the current tree. This is the most consequential finding of the night and it
decides the shape of the console.

### G1. Structured questions are a first-class, native concept

`ClaudeAdapter.ts:3758-3860` — when the model calls its **`AskUserQuestion`** tool, T3:

1. intercepts it in `canUseTool` (`raw.method: "canUseTool/AskUserQuestion"`),
2. emits a `user-input.requested` runtime event carrying `payload: { questions }`,
3. registers it in `pendingUserInputs`,
4. **blocks**: `const answers = yield* Deferred.await(answersDeferred)`,
5. on answer, emits `user-input.resolved` and unblocks.

The projection turns that into `pendingUserInputCount`
(`ProjectionSnapshotQuery.ts:1927,2072,2351`) → `hasPendingUserInput` on the thread shell →
the indigo **`Awaiting Input`** status in the sidebar.

The question schema is already exactly what a questionnaire needs
(`contracts/providerRuntime.ts:444-464`):

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
09:00** — and it stops for a *good* reason, which makes it worse: nothing is broken, so no
stall detector should fire, and the archived design's guard #8
(`!hasPendingUserInput` ⇒ skip, keep budget) deliberately refuses to nudge it.

The loop reactor and the question channel are therefore in direct tension:

- Nudge a thread parked on a real question ⇒ you push past the human's decision.
- Don't nudge it ⇒ the night is lost to one question.

### G3. Which means the console needs a *second*, non-blocking channel

The resolution is to stop treating "I need a human" as one thing. It is two:

| | **Blocking question** | **Deferred blocker** |
|---|---|---|
| Raised by | `AskUserQuestion` (native) | *does not exist yet* |
| Turn behaviour | parks until answered | returns immediately, agent carries on |
| Correct when | the next step genuinely cannot be chosen | the work can be re-ordered around it |
| Cost of waiting | the whole night | one item on a list |

The missing half is a fork-owned tool — call it `raise_blocker` — that records a question
**and returns immediately**, so the agent parks *that thread of work* and continues with
something else. #42's Phase 2 already sketched exactly the right home for it: a fork-owned
HTTP MCP toolkit, which is provider-agnostic (all five adapters already wire `mcpServers`
with a per-thread bearer credential) rather than Claude-only.

The console then aggregates three sources, and the distinction is the product:

1. **Blocking** — real `hasPendingUserInput` / `hasPendingApprovals` /
   `hasActionableProposedPlan`. *The loop is stopped on these.*
2. **Deferred** — `raise_blocker` items. *The loop kept going; answer at leisure.*
3. **Loop-authored** — skip reasons and stop reasons (`spent`, `stalled`, rate-limited).
   *Why the loop is not running right now.*

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

### F5. Deliverable shape

- An explanation for the **backend**.
- A **visual** for the frontend — HTML prototypes, embedded in the report.
- **All angles considered**, with explicit reasoning for why the rejected ones fail.
- If time allows: **the full backend test-case list**.
