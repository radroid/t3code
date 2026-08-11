---
name: worklog
description: Use when the user wants a work log or work report — "/worklog", "daily work log", "what did I ship today", "write up my week", "worklog setup", "worklog classify" — or names a date or date range and asks to recap what they worked on. Reconstructs the period from local T3code and Claude Code history, then drafts a shareable markdown report into the user's worklog repo. Draft only, never posts anywhere.
---

# worklog

Reconstruct what the user actually worked on over a period, and draft one shareable
markdown report per day into their worklog repo.

A CLI does all the reading — SQLite, Claude Code logs, git, `gh`, time clustering, leak
detection. You do the part that needs taste: which work mattered, how to tell it, what must
not be named.

## Non-negotiables

- **Never open the database or the raw `.jsonl` logs yourself.** No `sqlite3`, no `grep` over
  `~/.t3` or `~/.claude`, no reading a session transcript "just to check". The CLI is the only
  reader. One stray `grep` on a 700 MB database costs more than the whole report.
- **Read the summary, not the bundle.** `--print summary` is a few hundred lines. The JSON
  bundle is not for you.
- **Never quote raw chat.** No transcript lines, no prompt text, no tool output. Describe.
- **An unconfirmed project is private.** Anything the registry cannot vouch for is not named
  and not described. Silence is the safe default; ask, don't guess.
- **The lint gate is not optional.** A report that has not passed `worklog lint` is not
  finished, and `--allow` is not how you pass it.
- **Draft only.** Never post to Slack, GitHub, a blog, or anywhere else. Never run `git` in
  the worklog repo yourself — `worklog publish` is the only writer.
- Everything the CLI does is read-only toward the user's data. Keep it that way.

## Resolve the CLI first

Once per session, set `WORKLOG` to `bin/worklog.mjs` next to this SKILL.md. If you know the
absolute path of the file you are reading, use it directly. Otherwise:

```bash
for d in ~/.claude/skills/worklog ~/Developer/t3code/scripts/t3x/worklog; do
  [ -f "$d/bin/worklog.mjs" ] && WORKLOG="$d/bin/worklog.mjs" && break
done; echo "$WORKLOG"
```

Every command below is `node "$WORKLOG" <subcommand>`. It works from any cwd.

## Invocations

| The user says                                     | Do this                                                     |
| ------------------------------------------------- | ----------------------------------------------------------- |
| `/worklog`, "what did I ship today"               | Today's date, from = to = today.                            |
| "worklog for 2026-08-08", "yesterday"             | That one day.                                               |
| "worklog for last week", "2026-08-04..2026-08-08" | Range: run the pipeline per day, then a range report.       |
| "worklog setup"                                   | `init` + the first-run interview. See `reference/setup.md`. |
| "worklog classify"                                | The classify interview only. See `reference/setup.md`.      |

Resolve relative dates against the local clock and **say the resolved dates back** before
doing work. Never report on a day the user did not ask for.

## Pipeline

Run it in this order. Do not skip a step because the day looks small.

### 1. Doctor, or init

```bash
node "$WORKLOG" doctor --json
```

Read it. Then:

- Worklog repo missing → run `node "$WORKLOG" init`, then the first-run interview in
  `reference/setup.md`. Do not collect until the registry has at least one confirmed project.
- Unclassified projects listed → mention the count and offer `worklog classify`. Proceed
  regardless; they will be treated as private.
- `gh` missing or unauthenticated → say once that merged PRs will be absent, and continue.
- Databases missing → see `reference/troubleshooting.md`.

Skip this step on later runs in the same session.

### 2. Collect

```bash
node "$WORKLOG" collect --from 2026-08-10 --to 2026-08-10 --print summary
```

Read the summary. Note the bundle path it prints — the next step needs it. Read the
`warnings` block; a warning usually explains a number that will look wrong later.

If any figure in the summary surprises you, read `reference/data-model.md` before you write
a sentence about it. Several stats mean something narrower than their name suggests.

### 3. Extract, only if the summary says to

The summary marks sessions with `needsExtraction`. If there are none, go to step 4 — the
titles, signals, commits and PRs in the summary are enough.

Otherwise:

```bash
node "$WORKLOG" extract-queue --bundle <bundle-path-from-step-2> --limit 12
```

This writes one redacted slice per session to `.worklog-tmp/slices/<key>.md`. Dispatch **one
subagent per slice**, all in a single parallel batch, using the cheapest model available
(Haiku). Use exactly this prompt, substituting the slice path:

```text
You are summarising one coding session from a pre-redacted transcript slice.

Read ONLY this file: <ABSOLUTE PATH TO SLICE>
Do not read any other file. Do not open a database, a log, or a git repo. Do not run any
command. Do not search the codebase. The slice is the whole world.

Return ONLY a JSON object, no prose, no markdown fence, with exactly these five keys:

{
  "problem":   "what needed doing and why it mattered — <= 200 chars, 1-2 sentences",
  "approach":  "what was actually tried, including dead ends — <= 300 chars",
  "outcome":   "what ended up true at the end of the session — <= 300 chars",
  "artifacts": ["file basename, PR number, or command name", "..."],
  "status":    "shipped | in-progress | blocked | abandoned | exploration"
}

Rules:
- Past tense, plain words, specific. Name the real thing that broke.
- artifacts: at most 6 entries, each <= 80 chars. Basenames only — never a directory path.
- No file paths, no home directories, no URLs except a bare PR number, no emails, no tokens.
- Do not quote the transcript. Do not invent anything the slice does not support.
- If the slice shows nothing material, return empty strings, an empty artifacts array, and
  "status": "exploration".
```

Persist each returned object before using it:

```bash
node "$WORKLOG" extract-commit --session <session-key> --file /tmp/extract-<key>.json
```

If a subagent returns malformed JSON or `extract-commit` rejects it, do **not** hand-edit the
cursor — see `reference/troubleshooting.md`.

### 4. Write the day file

Sources allowed: the collect summary and the committed extracts. Nothing else.

Read `reference/report-format.md` for the template, the voice, and a worked example. Read
`reference/privacy.md` before naming anything. Write to `<worklogRoot>/days/YYYY-MM-DD.md`
(the root is in the summary's `config` block).

### 5. Self-check

Run the checklist at the end of `reference/privacy.md` against your own draft, question by
question. Lint catches shapes; the self-check catches meaning. Fix the draft, do not argue
with the checklist.

### 6. Lint — hard gate

```bash
node "$WORKLOG" lint --file <worklogRoot>/days/2026-08-10.md
```

Non-zero exit means the report does not ship. Fix the prose and re-run until it is clean.
Every finding carries a hint that says what to write instead. `--allow` exists, is
per-rule-id, and is almost always the wrong answer — `reference/troubleshooting.md` says when
it is not.

### 7. Publish

```bash
node "$WORKLOG" publish --date 2026-08-10
```

Lints again, then commits locally. It does not push and does not post. Tell the user the file
path and the one-line summary, and that it is a draft for them to edit.

## Ranges

Run steps 2–7 per day, then write `<worklogRoot>/ranges/<from>..<to>.md` from the day files
you just wrote — a through-line paragraph plus one line per day. Shape is in
`reference/report-format.md`. Then publish it the same way:

```bash
node "$WORKLOG" publish --range 2026-08-04..2026-08-08
```

Same lint gate, same local-only commit.

For a range longer than a week, confirm with the user first — it is one collect and one
extraction pass per day.

## When the day is thin

If there are no sessions, or only immaterial ones, write one honest line and stop:

```markdown
# 2026-08-09

Nothing substantial — a few minutes poking at a build failure, no changes landed.
```

Do not inflate a quiet day into a paragraph. Do not pad with token counts. A day with no
sessions at all gets "No recorded work." and no stat line.

## Reference

Read these when the step above says to, not before:

- `reference/data-model.md` — what each source can and cannot tell you, and the three traps.
- `reference/report-format.md` — template, voice guide, worked example, range shape.
- `reference/privacy.md` — visibility rules and the pre-lint self-check.
- `reference/setup.md` — the `init` and `classify` interviews.
- `reference/troubleshooting.md` — every failure mode and its fix.
