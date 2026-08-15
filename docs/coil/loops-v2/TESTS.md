# Loops — backend test plan

Written against the conventions already in the tree, not invented:

- **Pure logic** — `import { describe, expect, it } from "vite-plus/test"`. No server, no clock.
  `decide.ts`, `guards.ts`, `config.ts`, `sentinel.ts` are pure precisely so most of this list
  runs in microseconds.
- **Reactor / time** — `@effect/vitest` with `TestClock`, stub `OrchestrationEngineService`,
  `ProjectionSnapshotQuery` and `ProviderService` layers. Pattern is
  `coil/autoResume/Reactor.test.ts` verbatim.
- **Store** — real `FileSystem` against a temp dir (`NodeServices`), same as
  `autoResume/state.test.ts`.
- **Routes** — `http.test.ts` shape from `autoResume/http.test.ts`.
- Full suite: `vp run test --testTimeout=120000 --hookTimeout=120000`. Per-package runs are the
  trustworthy signal locally; full-suite flakes here are contention.

Counts below are cases, not files. **★** marks a case that encodes a bug this design exists to
prevent — if you cut scope, do not cut these.

---

## 1. `decide.ts` — the decision table (pure)

The single most valuable file to test, because every behaviour the user will ever complain about
resolves to one row here.

### 1.1 Trigger arithmetic

1. Idle below threshold → `skip`.
2. Idle exactly at threshold → `fire` (boundary is inclusive).
3. Idle above threshold → `fire`.
4. `busyTurn` true uses `busyIdleMs`, not `idleMs`. ★
5. `busyTurn` true and idle between the two thresholds → `skip` (this is the long-tool-call case).
6. `session.status === "starting"` counts as busy.
7. `latestTurn.state === "running"` counts as busy even when `session` is null.
8. **`session.status === "running"` alone never suppresses a fire — it only lengthens the fuse.** ★
   (A stale synthetic turn pins `running` forever; gating on it deadlocks the exact threads this
   feature is for.)
9. `processStartedAtMs` clamps the idle floor: a thread last updated 6 hours ago, on a server
   started 30 seconds ago, is **not** idle. ★
10. Unparseable `updatedAt` does not produce `NaN` idle and does not fire.
11. `updatedAt` in the future (clock skew) yields idle 0, not negative.

### 1.2 Budget and deadline

12. `checkInsUsed < maxCheckIns` → allowed.
13. `checkInsUsed === maxCheckIns` → `stop("spent")`.
14. `now >= deadlineAtMs` → `stop("spent")` **even when budget remains**. ★
15. Deadline null → never stops on time.
16. Deadline in the past at arm time is rejected by the route, not silently accepted (see §5).
17. `spent` is returned as `spent`, never as `done`. ★ (assert the literal, not truthiness)

### 1.3 Strikes

18. Movement ≥ `productiveMs` after a check-in resets strikes to 0.
19. Movement < `productiveMs` increments strikes.
20. Two consecutive unproductive check-ins → `stop("stalled")`.
21. One unproductive then one productive then one unproductive → still running (not cumulative). ★
22. Strikes are only evaluated when `lastCheckIn` is non-null.

### 1.4 Terminal stickiness

23. A record with `stopped != null` never fires, whatever else is true. ★
24. Terminal state survives a decision pass unchanged (no auto-clear).
25. Re-arm clears `stopped`, resets `checkInsUsed` and `strikes`, sets a fresh `armedAtMs`.

### 1.5 Handback

26. `latestUserMessageAt > lastCheckIn.createdAtIso` → `stop("handed-back")`. ★
27. `latestUserMessageAt` equal to the minted `createdAt` (our own nudge) does **not** trigger
     handback. ★ — exact string compare; this is the off-by-one that would disarm every loop on
     its own first check-in.
28. Handback does **not** reset budget. ★
29. Handback with `lastCheckIn === null` (armed, never fired) uses `armedAtMs` as the baseline.

---

## 2. `guards.ts` — ordering and effect (pure)

Each guard gets: passes-when-satisfied, blocks-when-not, and **the right kind of block**
(`skip` keeps budget / `disarm` / `stop`).

30. Global disabled → skip, budget intact.
31. `armed === false` → skip.
32. Shell `None` → **disarm** (thread deleted).
33. `archivedAt !== null` → disarm.
34. `settledOverride === "settled"` → skip, budget intact. ★
35. `snoozedUntil` in the future → skip, budget intact. ★
36. `snoozedUntil` in the past → passes.
37. `hasPendingApprovals` → skip. ★
38. `hasPendingUserInput` → skip. ★
39. `hasActionableProposedPlan` → skip. ★ — the guard every design in the original panel missed.
40. All three false → passes.
41. Auto-resume `pending != null` → skip. ★
42. `now < rateLimitedUntilMs` → skip, budget intact. ★
43. `now - lastCheckIn.firedAtMs < idleMs` → skip, **even if the idle threshold appears met**. ★
     (structural anti-tight-loop floor; must hold even when `updatedAt` never bumps)
44. `armedCount >= maxArmedThreads` → skip.
45. **Guard order is asserted explicitly**: a record that trips several guards reports the
     *first* one, because that string is what the console renders. ★
46. A skip never increments `checkInsUsed` — asserted across every ○ guard in one table-driven case. ★

---

## 3. `sentinel.ts` — the done-file (pure + fs)

47. No file at either root → no sentinel.
48. File under `worktreePath` → detected.
49. File under `workspaceRoot` → detected.
50. **Both present, worktree is newer → worktree wins.** ★
51. **Both present, workspaceRoot is newer → workspaceRoot wins** (newest mtime, not first found).
52. **`worktreePath` is checked first** — asserted by call order, not just by outcome. ★
     (`autoResume/Reactor.ts` has this precedence inverted; copying it silently breaks every
     worktree-backed thread.)
53. `mtime <= armedAtMs` → ignored (a stale file from a previous run cannot end a new one). ★
54. `mtime > armedAtMs` → honoured.
55. Stat error (EACCES, ENOENT on the dir, symlink loop) → "no sentinel", never a crash. ★
56. The supervisor never writes: assert no `writeFile` on the user's tree in any sentinel path. ★
57. Contents are irrelevant to detection; the first line is captured for display only.
58. A **model-authored timestamp inside the file is never read.** ★ — freshness is `mtimeMs` only.

---

## 4. `state.ts` — the durable store (real fs, temp dir)

59. Empty/missing file → `EMPTY_STATE`, no throw.
60. Round-trip: write a record, re-read, deep-equal.
61. **A file missing a field added later still decodes**, with the documented default. ★
     One case per field — this is the highest-severity footgun in the module, because a
     whole-file decode failure becomes `EMPTY_STATE` and silently disarms every loop.
62. A corrupt/truncated file → `EMPTY_STATE` and an error log, never a throw at boot.
63. Unknown extra keys are tolerated (forward compatibility with a newer build).
64. Concurrent mutations from two fibers serialize through the `SynchronizedRef` with no lost
     update. ★
65. The write is atomic: no partial file is observable mid-write.
66. Disk and memory stay consistent after a failed write (mutation rolls back or is retried, and
     the in-memory value never claims a persist that did not happen). ★
67. `recordCheckIn` persists **before** returning, so the reactor cannot dispatch on an
     unpersisted reservation. ★
68. Record lookup uses `Object.hasOwn`, so a thread literally named `constructor` or
     `__proto__` does not resolve a prototype member. ★
69. Blockers: add, answer, list-unanswered, and `deliveredToAgent` flip are all persisted.
70. Answering an already-answered blocker is idempotent, not a second append.

---

## 5. `http.ts` — the routes

71. Unauthenticated → 401.
72. Read scope only → 403 (these routes are operate scope).
73. `GET` unknown threadId → a default "off" record, not a 404.
74. `POST` arm → armed, with defaults filled from config.
75. `POST` arm with `maxCheckIns > 20` → **400**, not a clamp. ★ (the cap must be
     non-bypassable; a silent clamp hides a mistake)
76. `POST` arm with `maxCheckIns < 1` → 400.
77. `POST` arm with a deadline in the past → 400. ★
78. `POST` arm when already at `maxArmedThreads` → 400, and **the tick re-checks it too**, so a
     hand-edited state file cannot exceed the ceiling. ★
79. `POST` disarm on a running loop → disarmed, terminal reason `handed-back`.
80. `POST` re-arm after `spent` → clears terminal, fresh budget.
81. `POST answer` on a blocker → recorded, `deliveredToAgent` false.
82. `POST answer` on a **native** pending input routes to the existing resolve path, not the
     blocker store. ★ (two different mechanisms behind one console control)
83. `POST answer` for an unknown id → 404.
84. Malformed JSON body → 400, no state mutation.
85. Every response shape decodes against its schema (guards against drift with the client).
86. `GET /api/coil/loops` returns every armed loop across projects, ordered deterministically.

---

## 6. `Reactor.ts` — the fibers (TestClock)

87. Layer construction with `enabled=false` forks **no** fiber. ★
88. Nothing armed → **zero** snapshot queries per tick. ★ (cost guard; also protects the
     `getSnapshot` OOM lesson)
89. One armed, idle past threshold → exactly one `thread.turn.start` dispatched.
90. Two ticks while still idle → **still one** dispatch (guard 11's floor). ★
91. The dispatched command carries the `coil-loop:` id prefix on both `commandId` and `messageId`.
92. `runtimeMode` and `interactionMode` are copied from the shell, not defaulted. ★
93. **Reserve-before-dispatch**: a dispatch that throws still leaves `checkInsUsed` incremented,
     and the next tick does not immediately retry. ★
94. A dispatch that throws an arbitrary `Error` does not kill the fiber. ★
95. The shell is re-read **after** the guard block and before dispatch; a thread that becomes
     settled in that window is not nudged. ★ (the wake race)
96. `settledOverride === "active"` → a `thread.unsettle` follows the turn start.
97. `settledOverride === null` → **no** `thread.unsettle` is issued (it can never create a pin). ★
98. A failed pin-repair dispatch logs **and** appends an error-tone breadcrumb — never silent. ★
99. Budget exhaustion writes `stopped: spent` exactly once, and the next tick is a no-op.
100. Rate-limit fiber: an `account.rate-limits.updated` with `status: rejected` writes
     `rateLimitedUntilMs` durably. ★
101. A non-rejected verdict does not write.
102. The rate-limit subscription does **not** consume events auto-resume needs (both subscribers
     see them — PubSub, not queue). ★
103. Boot grace: with `processStartedAtMs = now`, a long-idle armed thread does not fire on the
     first tick. ★
104. After `processStartedAtMs + idleMs`, it does fire.
105. Breadcrumbs are **edge-detected**: a loop skipping for the same reason across 10 ticks
     appends **one** activity, not ten. ★ (otherwise the reactor resets its own idle clock —
     a self-sustaining loop)
106. A breadcrumb append failure does not abort the check-in.
107. Fiber interruption (server shutdown) mid-decision leaves the store consistent.

---

## 7. `mcp/toolkits/loop` — the question channel

108. `raise_blocker` returns **immediately**; the tool call does not await anything. ★
     Assert elapsed time, not just the return value — this is the entire reason the tool exists.
109. The blocker is attributed to the calling thread from `McpInvocationContext`, not from an
     argument. ★ (an argument could be spoofed or wrong)
110. `raise_blocker` with no options → free-text blocker, still valid.
111. `raise_blocker` with options → shape matches `UserInputQuestion` so the console can render
     it with the native component. ★
112. Called from a thread with **no armed loop** → recorded anyway and surfaced in that thread's
     console (a blocker is useful without a loop).
113. Rate/volume cap: an agent that calls it 200 times in a turn is bounded, and the cap is
     reported back to the agent rather than silently dropping. ★
114. `loop_status` returns the true remaining budget and deadline.
115. `loop_status` on an unarmed thread returns "no loop", not an error.
116. `loop_done` writes the terminal state and is equivalent to the sentinel file.
117. `loop_done` from a thread with no loop is a no-op, not a crash.
118. All three tools are unavailable when the global toggle is off. ★

---

## 8. Prompt composition — `config.ts`

119. Resolution order: per-thread override → `.coil/loop-prompt.md` → built-in.
120. The done-file path is interpolated **absolute**, and uses `worktreePath ?? workspaceRoot`. ★
121. The check-in number and budget are interpolated correctly at every position (1 of 6 … 6 of 6).
122. **Answered-but-undelivered blockers are included**, then marked delivered. ★
123. A blocker answered *after* the prompt was composed is not marked delivered (no lost answer). ★
124. The prompt never begins with `/` (it would be read as a slash command). ★
125. The scheduler-ownership line is always present, in every resolution path. ★
126. A `.coil/loop-prompt.md` that is empty or whitespace falls through to the built-in.
127. An unreadable `.coil/loop-prompt.md` falls through and logs, rather than failing the check-in.

---

## 9. Integration — the scenarios that motivated the feature

Heavier tests; a handful, each replaying a real failure.

128. **The original night.** A thread whose turn completes at 00:19 while `task.*` activities keep
     arriving until 00:52, then silence. Assert: no fire during the activity stream (they bump
     `updatedAt`), and exactly one fire at ~01:07. ★ This is the acceptance test for the whole
     feature.
129. **Restart mid-loop.** Arm, fire twice, kill and rebuild the layer from disk. Assert budget,
     deadline, strikes and `armedAtMs` all survive and the loop continues from check-in 3. ★
130. **Reboot storm.** Three armed threads, all long-idle, server restarts. Assert none fire on
     the first tick and they do not all fire simultaneously afterwards. ★
131. **Loop vs auto-resume.** A rate limit arrives while a loop is armed with auto-resume off.
     Assert the loop does not nudge into the live limit and spends no budget. ★
132. **Loop vs auto-resume, the other direction.** A pending auto-resume exists; assert the loop
     stands down and does not destroy the pending resume.
133. **Blocking question overnight.** Agent calls `AskUserQuestion` at 01:00. Assert the loop
     skips (guard 8), spends nothing, and the console shows it as blocking-since. ★
134. **Deferred blocker overnight.** Agent calls `raise_blocker` at 01:00. Assert the turn
     continues, the loop keeps firing normally, and the answer reaches the agent on the next
     check-in prompt. ★ — the two cases together are the proof that the channel split works.
135. **Empty console.** A loop that ends `spent` with a model that never called `raise_blocker`.
     Assert the console still renders the stop reason and the budget — it degrades to useful, not
     to silence. ★ (§9.3 of BACKEND.md's acceptance test)
136. **Human takeover at 04:00.** Assert disarm, no budget reset, and one-tap re-arm restores a
     full budget.
137. **The done-file.** Agent writes it at check-in 3; assert `done`, three check-ins unused, and
     `done` is not reported as `spent`. ★

---

## 10. What is deliberately *not* tested, and why

- **`raw.method === "claude/synthetic-turn-start"`.** Real on the wire, but
  `RuntimeEventRaw.method` is a free optional string with no literal union and no upstream test,
  in a churn-12 hot file. A fork test asserting a fork-defined constant cannot detect upstream
  drift — it would pass green while the feature silently broke. The design avoids depending on it
  at all; testing it would create the illusion of coverage.
- **Dollar cost.** `total_cost_usd` is unverified per-turn-vs-per-session. Asserting anything
  about it would pin behaviour we do not understand.
- **Claude's cron tools.** Not the mechanism, so not on the critical path. If `session_crons`
  observation ships in Phase 3, it gets its own cases then.

---

## 11. Coverage gates worth enforcing

- `decide.ts` and `guards.ts` at **100% branch** — they are pure, small, and every branch is a
  product decision.
- One test per ○ guard asserting **budget is unchanged**, table-driven, so a new guard added
  without that property fails the suite.
- A test that fails if a new field is added to `LoopRecord` without a decoding default. ★
  (schema-reflective; this is the failure that silently disarms every loop on the machine)
