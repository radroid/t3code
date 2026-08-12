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
- **Read the summary, not the bundle.** What `collect` prints by default is a few hundred
  lines. The JSON bundle it writes is not for you — you pass its path around, you never open
  it.
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
for d in ~/.claude/skills/worklog ~/Developer/t3code/scripts/coil/worklog; do
  [ -f "$d/bin/worklog.mjs" ] && WORKLOG="$d/bin/worklog.mjs" && break
done; echo "${WORKLOG:-NOT FOUND}"
```

If that prints `NOT FOUND`, stop and ask the user where the skill is checked out — do not
start the pipeline with an unresolved path.

Every command below is `node "$WORKLOG" <subcommand>`. It works from any cwd. Every one takes
`--json`; exit 2 is a usage error, exit 1 means the command did its check and refused.

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
- The `registry` check reports `projects` and `confirmed`. Fewer confirmed than projects →
  mention the gap and offer `worklog classify`. Proceed regardless; anything unconfirmed is
  treated as private. Projects the registry has never heard of do not appear here at all —
  they surface in step 2's summary.
- `gh` missing or unauthenticated → say once that merged PRs will be absent, and continue.
- Databases missing → see `reference/troubleshooting.md`.

`doctor --json` is also where the worklog repo's path comes from: the `worklog-root` check
carries it as `root`. You will need it in step 4.

Skip this step on later runs in the same session.

### 2. Collect

```bash
node "$WORKLOG" collect --from 2026-08-10 --to 2026-08-10
```

Read the summary it prints. The **last line** is `bundle: <path>`, and steps 3, 6 and 7 all
need that path — so leave `--print` at its default (`both`). `--print summary` prints the same
digest but no bundle path, and `--print json` dumps the whole bundle to stdout, which is the
one thing you must not read.

Read the `warnings` block; a warning usually explains a number that will look wrong later. If
the summary carries an **Unclassified projects** or **Unconfirmed projects** section, the
report needs the heads-up line — see `reference/report-format.md`.

If any figure in the summary surprises you, read `reference/data-model.md` before you write
a sentence about it. Several stats mean something narrower than their name suggests.

### 3. Extract, only if the summary says to

The summary lists them under **Sessions needing extraction**. If that section is absent, go to
step 4 — the titles, signals, commits and PRs in the summary are enough.

Otherwise:

```bash
node "$WORKLOG" extract-queue --bundle <bundle-path-from-step-2> --limit 12
```

Without `--limit` it stops at 8. Sessions are queued most-material first, so a cap costs you
the least interesting ones.

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
- All three of problem, approach and outcome must be non-empty — an empty one is rejected. If
  the slice is thin, say plainly what little it shows ("only tool activity, no prose") and set
  "status": "exploration". Never pad, never guess.
```

Persist each returned object before using it. `--bundle` is required — the same bundle path
from step 2, because the bundle carries the session record the cursor is advanced against:

```bash
node "$WORKLOG" extract-commit --session <session-key> --bundle <bundle-path-from-step-2> \
  --file /tmp/extract-<key>.json
```

If a subagent returns malformed JSON or `extract-commit` rejects it (exit 2 — it names every
violation), do **not** hand-edit the cursor and do **not** trim the JSON to fit. See
`reference/troubleshooting.md`.

### 4. Write the day file

Sources allowed: the collect summary and the committed extracts. Nothing else.

Read `reference/report-format.md` for the template, the voice, and a worked example. Read
`reference/privacy.md` before naming anything. Write to `<worklogRoot>/days/YYYY-MM-DD.md` —
the root is the `worklog-root` check's `root` from step 1, and it is also the directory three
levels above the `bundle:` path from step 2. The summary itself does not print it.

### 5. Self-check

Run the checklist at the end of `reference/privacy.md` against your own draft, question by
question. Lint catches shapes; the self-check catches meaning. Fix the draft, do not argue
with the checklist.

### 6. Lint — hard gate

```bash
node "$WORKLOG" lint --file <worklogRoot>/days/2026-08-10.md --bundle <bundle-path-from-step-2>
```

Pass `--bundle`. Without it the gate cannot check the names of projects the registry has never
heard of, and it warns that it did not.

Non-zero exit means the report does not ship. Fix the prose and re-run until it is clean.
Every finding carries a hint that says what to write instead. Only `error` findings block;
`warn` findings still deserve a rewrite. `--allow` exists, is per-rule-id, and is almost always
the wrong answer — `reference/troubleshooting.md` says when it is not.

### 7. Publish

```bash
node "$WORKLOG" publish --date 2026-08-10
```

Lints again — finding the day's bundle by itself, so no `--bundle` here — then commits the day
file plus `config/` and `extracts/` locally. It does not push and does not post. Exit 1 means
it refused: a blocking finding, no file, or nothing changed since the last publish. Tell the
user the file path and the one-line summary, and that it is a draft for them to edit.

## Ranges

Run steps 2–7 per day, then write `<worklogRoot>/ranges/<from>..<to>.md` from the day files
you just wrote — a through-line paragraph plus one line per day. Shape is in
`reference/report-format.md`. Then publish it the same way:

```bash
node "$WORKLOG" collect --from 2026-08-04 --to 2026-08-08 --no-git
node "$WORKLOG" publish --range 2026-08-04..2026-08-08
```

Same lint gate, same local-only commit. The extra `collect` is not for the prose — it is
because `publish --range` looks for a bundle named for the whole range, and the per-day passes
never write one. Skip it and the range file publishes with its unclassified-project check
switched off, and says so in a warning. `--no-git` keeps it cheap; the gate only needs the
project names.

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

- `reference/data-model.md` — what each source can and cannot tell you, the four traps, and
  which numbers are softer than they look.
- `reference/report-format.md` — template, voice guide, worked example, range shape.
- `reference/privacy.md` — visibility rules and the pre-lint self-check.
- `reference/setup.md` — the `init` and `classify` interviews.
- `reference/troubleshooting.md` — every failure mode and its fix.
