# Setup and classify

Two interviews. `setup` runs once, when the worklog repo does not exist. `classify` runs any
time new projects show up. Both end in the same place: every project the user cares about has
a confirmed row in `config/projects.yaml`.

Batch the questions. One screenful, answered in one message, is the goal — an interrogation
that asks three questions per project will not get finished, and an unfinished registry means
everything is treated as private.

## First run (`worklog setup`)

### 1. Scaffold

```bash
node "$WORKLOG" init
```

Idempotent. Creates the worklog repo (default `~/Developer/worklog`, overridable with
`--root DIR` or the `WORKLOG_ROOT` environment variable), initialises git with no remote,
writes the README and `.gitignore`, and discovers projects from the local T3code and Claude
Code history. Every discovered project lands as a **proposed, unconfirmed** entry, so nothing
is nameable until the user says so.

Tell the user where the repo was created and that it has no remote by design.

### 2. Confirm identities

```bash
node "$WORKLOG" projects --json
```

Show the discovered `identities` list — the git author names and emails whose commits count
as the user's. Ask one question: _"Are these all you? Anything missing?"_ A missing identity
silently drops commits from every report, so it is worth the one question.

### 3. The batched classification question

Show the discovered projects as a compact list — key, display name, and a hint of the
evidence (session count, repo root basename). Then ask **once**:

> For each project, tell me: **public** (I can name it and link it), **generic** (describe the
> work but never name the client), **private** (count the hours, say nothing), or **skip**
> (leave it out entirely). A one-line answer per project is plenty — e.g. `tidepool: public,
github.com/example-user/tidepool`. Anything you don't answer stays private.
>
> 1. `tidepool` — Tidepool (14 sessions, repo `tidepool`)
> 2. `quill` — Quill (6 sessions, repo `quill`)
> 3. `northwind` — northwind (9 sessions, repo `northwind-app`)

Rules for asking:

- One numbered line per project, no sub-questions.
- Cap it at roughly a dozen. If discovery found more, ask about the ones with the most
  sessions and say the rest stay private until they ask for them.
- Offer sensible defaults out loud ("anything you don't answer stays private") so a partial
  answer is still a complete outcome.
- Ask for a link only for `public` ones, on the same line.
- Do not ask for a blurb. Write one yourself from the evidence and let the user correct it.

### 4. Ask about always-redact terms

One more question, once:

> Any names that must never appear in a work log — clients, employers, product code names?
> I'll add them to the redaction list with a neutral replacement for each.

### 5. Write it back

Record every answer, then read the file back to the user in full so they can correct it in
one pass. A project the user did not classify keeps `confirmed: false` — do **not** invent a
visibility for it.

## Re-running (`worklog classify`)

Run this whenever `collect` reports unclassified projects, or when the user asks.

```bash
node "$WORKLOG" projects --json
```

Ask only about entries that are new or unconfirmed — never re-litigate a settled project.
Same batched format, same defaults. If there is nothing unclassified, say so in one line and
stop; do not walk the user through a registry that is already correct.

Changing an existing project's visibility is a normal thing to want. Confirm the change back
in one line ("`quill` is now generic — it will be described but not named") because it
silently rewrites how every future report reads.

## The resulting YAML

`config/projects.yaml` after the example interview above:

```yaml
version: 1
# Git author names and emails whose commits count as mine.
identities:
  - example-user@users.noreply.github.com
  - Example User
# Time-clustering knobs. activeGapMinutes splits the day into activity blocks.
defaults:
  active_gap_minutes: 30
  single_event_minutes: 1
# One entry per project. Add roots so sessions and repos can be matched to it.
projects:
  tidepool:
    display_name: Tidepool
    roots:
      - /Users/example-user/Developer/tidepool
    include: true
    visibility: public
    confirmed: true
    link: https://github.com/example-user/tidepool
    blurb: Open-source sync engine
  quill:
    display_name: Quill
    roots:
      - /Users/example-user/Developer/quill
    include: true
    visibility: generic
    confirmed: true
    blurb: A client's editor product
  northwind:
    display_name: northwind
    roots:
      - /Users/example-user/Developer/northwind-app
    include: true
    visibility: private
    confirmed: true
  scratch:
    display_name: scratch
    roots:
      - /Users/example-user/Developer/scratch
    include: false
    visibility: private
    confirmed: true
```

`config/redaction.yaml`:

```yaml
version: 1
# Never let these appear in a published report.
always_redact:
  - Northwind Retail
# What to say instead.
replacements:
  Northwind Retail: a retail client
```

Notes on the shape:

- Keys are snake_case in YAML. The parser is a deliberately small subset: comments, nested
  maps by two-space indent, block sequences of scalars, quoted or bare scalars, booleans and
  integers. **No anchors, no flow collections (`[a, b]`), no multiline scalars, no tabs, no
  sequences of maps.** Keep hand edits flat.
- `roots` is what matches a session or a repo to a project. A project with no root will only
  ever match by name, which usually means it matches nothing.
- `include: false` removes a project from the totals as well as the prose. Use it for scratch
  directories; use `private` for real work that must stay quiet.
- `link` and `blurb` are optional and only used for `public` projects.
