# Troubleshooting

Every command treats a missing database, a missing `gh`, or an offline network as a warning,
not a failure. So the usual symptom is not a crash — it is a report that is quietly wrong.
Read the `warnings` block in the collect summary before you read the numbers.

## No databases found

`doctor` reports no T3code state database, or `collect` returns zero sessions on a day the
user says they worked.

- The T3code database lives under the T3 base directory as `state.sqlite`. A **dev** base
  directory usually exists and is usually empty — an empty dev database is normal and is not
  the one you want.
- `collect` reads whatever bases it finds. If it found only the empty one, every T3code stat
  will be zero while Claude Code sessions still appear. That asymmetry in the summary is the
  tell.
- Fix: ask the user whether T3code stores state somewhere non-default, then re-run `doctor`.
  Do not go looking for the file yourself, and never open it directly.
- If the Claude Code projects directory is also missing, there is no evidence at all — say so
  and stop. Do not write a report from git commits alone unless the user asks for that.

## `gh` missing or not authenticated

The tell is a warning on a repo in the summary's `git` block, plus zero merged PRs.

- Merged PRs are **absent, not zero**. Never write "no PRs merged" in this case; drop the PR
  slot from the stat line entirely and say nothing about PRs in prose.
- Commits are unaffected — they come from local git and are still trustworthy.
- Fix: tell the user `gh auth login` will restore PR data, and offer to re-run collect after.
- On a fork, PR lookups are scoped to the repo's own `origin` remote. If PRs from the wrong
  repository appear, that is a collector bug — report it, do not work around it in prose.

## An empty day

Zero sessions and zero commits.

- First check the date resolved the way the user meant. "Yesterday" across a late-night
  session is the usual culprit: work after midnight belongs to the next day, because the day
  boundary is local midnight.
- If the date is right, write the thin-day line from SKILL.md and stop. Do not widen the
  window to find something to say.
- A day with sessions but nothing material (no completed turns touching files, fewer than
  three tool activities, fewer than two prompts) is a real outcome too: "a few minutes poking
  at X, nothing landed".

## A lint finding you think is a false positive

Assume it is not. The rules are tuned so that a match inside a higher-priority rule is
suppressed and links to public code hosts are exempt from the path rules, so a finding that
survives usually means something.

The right order:

1. **Rewrite the sentence.** Every finding carries a hint that says what to write instead.
   `long-path` wants a basename. `private-project` wants a description instead of a name.
   `raw-quote` wants a summary instead of a transcript. Rewriting is almost always faster
   than arguing, and it usually improves the prose.
2. **Fix the registry, if the finding is right about the world.** `private-project` firing on
   a genuinely public project means the registry is wrong, not the report. Set
   `visibility: public` and `confirmed: true` — with the user's say-so — and re-run.
3. **Only then, `--allow`.** It takes rule ids and it means "do not fail on this rule", not
   "this is fine":

   ```bash
   node "$WORKLOG" lint --file <file> --allow long-path
   ```

   It is per-rule and file-wide, so allowing `long-path` to save one sentence disables the
   check for every other path in the report. Never allow `secret-shape`, `redact-term`,
   `private-project`, `email`, `home-path` or `tilde-path` — those are the reasons the gate
   exists. `long-path` and `raw-quote` are the only two ever worth allowing, and only after
   you have read every finding they suppress. Tell the user you used it and why.

`lint-unavailable` is not a false positive under any circumstance: it means the gate did not
run, so nothing was checked and nothing is cleared.

## A corrupt extract

A subagent returned something that is not the five-key object, or `extract-commit` rejected it.

- Do **not** hand-write the extract file and do **not** touch anything under `extracts/` — the
  cursor in there is what guarantees no message is ever read twice. A hand-edited cursor
  silently skips real work on every future run.
- Re-dispatch the subagent for that one slice with the same prompt. A second attempt usually
  returns clean JSON.
- If it fails twice, drop that session: write the day from its title, signals, commits and
  PRs instead. One missing extract costs a paragraph, not the report. Say nothing in the
  report about the failure.
- If `extract-commit` rejects a `status` value, it prints the set it accepts — use that set,
  and re-dispatch rather than editing the JSON to fit.

## The bundle looks wrong

Numbers that do not match the user's memory of the day.

- **Agent runtime far exceeds the wall clock.** Correct. Sessions run in parallel; the number
  is machine time, not elapsed time. Gloss it in the stat line and move on.
- **Active time looks short.** It is a floor. Reading, meetings and thinking leave no events,
  and gaps over 30 minutes are dropped by design. `--gap N` widens the gap for one run if the
  user's rhythm genuinely differs; changing `active_gap_minutes` in the registry makes it
  permanent.
- **Session count looks doubled.** The dedup join (worktree, then first-prompt hash) missed a
  pair. Describe the work once and leave the count out of the stat line rather than publishing
  an inflated number.
- **Files touched looks far too low.** Expected: most turns record no file list. Do not report
  it.
- **A project is missing entirely.** It is unclassified or `include: false`. Check
  `worklog projects`, not the bundle.
- **Commits missing.** Either the repo root is not in any project's `roots`, or the commit
  author is not in `identities`. Both are registry fixes.

Never open the JSON bundle to investigate. If the summary cannot answer the question, re-run
collect with different flags or ask the user.

## Re-running cheaply

- `collect` is cheap and repeatable — re-run it freely with `--gap`, `--no-git`, or a
  different window. It writes only into the temp directory.
- Extraction is the only expensive step, and it is incremental: a session with nothing new
  since its cursor is never queued again. Re-running a day you already reported costs almost
  nothing.
- `--limit N` on `extract-queue` caps how many slices you dispatch in one pass. Use it on a
  busy day, take the most material sessions first, and run a second pass only if the report
  actually needs it.
- `.worklog-tmp/` is gitignored and safe to delete at any time. Deleting it does **not** lose
  extracts or cursors — those live in `extracts/`.
- `lint` is free. Run it as often as you like, including on a half-written draft.
- If a run went badly wrong, the safe reset is to delete the day file and start from step 2.
  Never reset by deleting anything under `extracts/`.
