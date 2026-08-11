# `/worklog` — design and module contract

Tracking issue: [radroid/t3code#65](https://github.com/radroid/t3code/issues/65).

This is the durable design record **and** the interface contract every module in
`scripts/t3x/worklog/` is written against. Change the contract here first, then the code.

---

## 1. What it is

A Claude Code skill that reconstructs what Raj worked on over a period and writes a
**draft, human-reviewed, socially shareable markdown work log** — one file per day — into a
dedicated `~/Developer/worklog/` git repo.

Two halves, deliberately split:

| Half                         | Owns                                                                                                                                                     | Why                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bin/worklog.mjs` (+ `lib/`) | Everything deterministic: reading SQLite, scanning Claude Code logs, shelling out to git/`gh`, clustering time, applying the registry, linting for leaks | The model must never grep a 719 MB database. Deterministic work is cheap, testable, and reproducible. |
| `SKILL.md` (+ `reference/`)  | Everything that needs taste: which work mattered, the narrative voice, the redaction judgement call                                                      | This is the part a model is actually good at.                                                         |

The collector emits a JSON **evidence bundle**; the skill reads a compact summary of it and
writes prose. That boundary is the token-efficiency strategy.

## 2. Where things live

Source of truth (this repo, fork-only path — additive seam, no upstream collision):

```
scripts/t3x/worklog/
  SKILL.md                    # skill entry point (frontmatter: name, description)
  reference/
    data-model.md             # verified schema facts + gotchas
    report-format.md          # the day-file template and voice guide
    privacy.md                # visibility model, redaction rules, self-check
    setup.md                  # `setup` / `classify` interview flows
    troubleshooting.md
  bin/worklog.mjs             # single CLI entry, subcommand dispatch
  lib/*.mjs                   # zero-dependency ES modules (node:sqlite, node 22+)
  test/*.check.mjs            # node:test suites — see §11 for why not *.test.mjs
  test/run.mjs                # `node scripts/t3x/worklog/test/run.mjs [name ...]`
```

Installed machine-wide by symlink: `~/.claude/skills/worklog -> ~/Developer/t3code/scripts/t3x/worklog`
(the same pattern as the other skills in `~/.claude/skills`, which are all symlinks).

Generated data (separate private repo, created by `worklog init`):

```
~/Developer/worklog/
  README.md                   # states: private, no remote, what is safe to publish
  .gitignore                  # ignores .worklog-tmp/
  config/projects.yaml        # registry: include + visibility + confirmed, per project
  config/redaction.yaml       # always_redact terms + replacements
  days/YYYY-MM-DD.md          # the reports (the deliverable)
  ranges/YYYY-MM-DD..YYYY-MM-DD.md
  extracts/{t3,cc}-<id>.json  # per-session condensed extract + read cursor
  .worklog-tmp/               # bundles + transcript slices; gitignored, safe to delete
```

## 3. Verified data-model facts

Confirmed by direct inspection on 2026-08-10 (83 threads / 549 turns / 12 projects in
`~/.t3/userdata/state.sqlite`; `~/.t3/dev/state.sqlite` exists but is empty).

**T3code SQLite** — read-only, always via `file:<path>?mode=ro` / `node:sqlite` `readOnly: true`.

- `projection_projects(project_id, title, workspace_root, deleted_at, ...)` — `workspace_root`
  is the repo path. Two rows can share a title (`t3code` appears twice, different roots).
- `projection_threads(thread_id, project_id, title, branch, worktree_path, created_at,
updated_at, deleted_at, archived_at, model_selection_json, latest_user_message_at)` —
  titles are model-generated and genuinely descriptive ("Sync fork with upstream and verify
  release"); they are the single best free signal. `worktree_path` is populated for only
  7/83 threads — **do not depend on it**. `model_selection_json` is
  `{"instanceId":"claudeAgent","model":"claude-opus-4-8","options":[…]}`.
- `projection_turns(thread_id, turn_id, state, requested_at, started_at, completed_at,
checkpoint_files_json)` — timing lives here. `checkpoint_files_json` is
  `[{path, kind, additions, deletions}]`, **empty for ~62% of turns**, so file-level stats
  from turns are a bonus, never the backbone. Running turns have `completed_at = null`.
- `projection_thread_activities(kind, tone, summary, payload_json, created_at, sequence)` —
  ⚠️ **the issue's assumption that `summary` is an LLM-condensed one-liner is wrong.**
  `summary` is a generic label ("Command run", "File change", "Task completed"). The real
  signal is `payload_json`:
  - `task.progress` → `{taskId, title, detail, lastToolName, usage:{total_tokens, tool_uses,
duration_ms}}`. `title` _is_ a condensed description, and `usage.total_tokens` is
    **cumulative per `taskId`** — take the max per task, then sum; never add the rows.
  - `tool.completed` / `tool.started` → `{itemType, detail, data:{toolName, input, result}}`.
    `detail` is a short "Bash: …"-style line. **`data.result` contains full tool output —
    never read it into a prompt, never write it to disk.**
- `projection_thread_messages(thread_id, turn_id, role, text, created_at)` — the raw chat.
  Only read what the cursor says is new, only for sessions that need extraction.
- `projection_thread_sessions.provider_session_id` is **NULL for every row** — there is no
  stored link from a thread to its Claude Code session id. See §6 for how we link anyway.

**Claude Code logs** — `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (475 files here).

- The directory name encoding is lossy (`/Users/x/.t3/…` → `-Users-x--t3-…`, both `/` and `.`
  become `-`). **Never decode a path from the directory name** — read `cwd` off the records.
- Record types seen: `user`, `assistant`, `attachment`, `system`, `mode`, `queue-operation`,
  `last-prompt`, `pr-link`. There are **no `summary` records in this user's history**, so the
  cheap tier must use the first real user prompt + `last-prompt` + git evidence.
- `user`/`assistant` records carry `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`,
  `uuid`, `parentUuid`. A real prompt has `message.content` as a string, or an array whose
  first element is `{type:"text"}`; tool results are arrays of `{type:"tool_result"}`.
- `pr-link` records give `{prNumber, prUrl, prRepository, timestamp}` for free.

**git / `gh`** — nothing is persisted by T3code, so shell out at generation time.

- ⚠️ `radroid/t3code` is a **public fork of `pingdotgg/t3code`**. Bare `gh pr list` resolves to
  the _parent_. Always derive `nameWithOwner` by parsing `git remote get-url origin` and pass
  `--repo`. (This has bitten the fork before — see the sync-agent runbook.)
- Worktrees share one object store: canonical repo identity is
  `realpath(git rev-parse --git-common-dir)`, so the three t3code worktrees collapse to one repo.

## 4. Config file formats

Both config files are parsed by `lib/yamlLite.mjs`, a **deliberately small YAML subset** —
no dependencies, and the schemas below are flat on purpose so the subset stays honest.

Supported: `#` comments, `key: value` maps nested by two-space indent, block sequences of
scalars (`- item`), double/single-quoted and bare scalars, `true|false|null`, integers.
Not supported (and rejected with a clear error): anchors, flow collections, multiline
scalars, tabs, sequences of maps. The writer emits canonical, round-trippable output.

`config/projects.yaml`:

```yaml
version: 1
# Identities that count as "my" commits.
identities:
  - 25481060+radroid@users.noreply.github.com
  - Raj D
defaults:
  active_gap_minutes: 30
  single_event_minutes: 1
projects:
  t3code:
    display_name: T3 Code (fork)
    roots:
      - /Users/rajdholakia/Developer/t3code
    include: true
    visibility: public # public | generic | private
    confirmed: true # false ⇒ treated as private + flagged in the header
    link: https://github.com/radroid/t3code
    blurb: My fork of the T3 Code agent IDE
```

`config/redaction.yaml`:

```yaml
version: 1
always_redact:
  - Some Client Name
replacements:
  Some Client Name: a client
```

**Visibility semantics** (enforced by `lint`, described to the model in `reference/privacy.md`):

| state                   | named?         | described?                           | counted in stats?                         |
| ----------------------- | -------------- | ------------------------------------ | ----------------------------------------- |
| `public` + confirmed    | yes, with link | yes                                  | yes                                       |
| `generic` + confirmed   | no             | yes, anonymised ("a client project") | yes                                       |
| `private` + confirmed   | no             | no                                   | yes                                       |
| any, `confirmed: false` | no             | no                                   | yes, **and flagged in the report header** |
| `include: false`        | no             | no                                   | no                                        |

## 5. Time metrics

Two numbers, reported side by side, because they answer different questions:

- **Active time** — union of _activity blocks_ across every session: sort all event
  timestamps, split wherever the gap exceeds `active_gap_minutes` (default 30), sum
  `last − first` per block, and give a lone-event block `single_event_minutes`. Because the
  blocks are built from the merged timeline, parallel sessions do not double-count. Bounded
  by wall-clock. This is "how long was I at the desk".
- **Agent runtime** — Σ per-turn `completed_at − started_at` (T3code) and Σ per-prompt spans
  (Claude Code: a user prompt to the last record before the next user prompt). Sessions run
  in parallel, so this legitimately exceeds active time and often exceeds 24 h. This is "how
  much machine time I directed".

Both are clipped to the local day window. `new Date(y, m-1, d)` gives local midnight — that is
the day boundary; no UTC arithmetic anywhere. Turns still running at the window edge are
clipped to `min(now, dayEnd)`.

## 6. Which sessions are real work

Two different things inflate the session count, and both were found by running the collector
against a real day (2026-08-10: **13 genuine T3code threads, reported as 43 sessions** before
these rules existed). The ladder below runs per Claude Code session, first match wins:

0. **Machine rule** — the session is tooling talking to itself, not a person working. Two arms:
   - _known-prompt_: the first prompt starts with one of `MACHINE_PROMPT_PREFIXES`. These are
     real, verified senders, not guesses — T3code's own thread-title generation
     (`apps/server/src/textGeneration/TextGenerationPrompts.ts`, both the initial and regenerate
     prompts), the `security-guidance` plugin's review and re-review calls (`hooks/llm.py`), and
     a provider reachability ping.
   - _utility-shape_: ≤ 1 prompt, ≤ 2 assistant records, ≤ 1 tool use, and under 120 s. This is
     the arm that caught T3code's branch-name generator without anyone having listed it. It is
     deliberately narrow so a genuine quick question survives.
1. **Worktree rule** — `cwd` under a T3 worktrees root (`~/.t3/worktrees/`) or equal to a
   thread's `worktree_path` ⇒ T3code-driven.
2. **Prompt-hash rule** — SHA-256 of the normalised (trimmed, whitespace-collapsed, lowercased,
   first 400 chars) first user prompt matches a `projection_thread_messages` user text hash from
   the same day ⇒ T3code-driven.
3. Otherwise it is a standalone Claude Code session and counts on its own.

Excluded sessions stay in the bundle carrying `excluded: {reason, rule, linkedTo}` — the count is
honest _and_ a human can audit every join rather than trusting a number.

**Project roots have the mirror problem.** A session `cwd` is sometimes `~` or a scratch dir, and
`matchProjectByRoot` resolves by path containment, so a registry entry rooted at `~` would
silently claim every other project's sessions. Discovery therefore never proposes the home
directory, the filesystem root, or anything under a scratch root (`DEFAULT_SCRATCH_ROOTS`;
overridable, because the tests build fixtures in exactly those directories).

And containment cuts the other way too: **a nested repo must not be adopted by its parent.**
`inbox-lens` is its own git repo inside `mission-control`'s directory tree; keying discovery off
`matchProjectByRoot` folded it into its parent and attributed its work to another project.
Discovery reuses an existing registry key only on an **exact** root match. Containment is the
right rule for attributing a _session_ to a project, and the wrong one for naming a _project_.

## 7. The evidence bundle (`worklog collect`)

`schemaVersion: 1`. Written to `.worklog-tmp/bundle-<from>_<to>.json`. Shape:

```jsonc
{
  "schemaVersion": 1, "generatedAt": "…", "warnings": ["…"],
  "range": { "from": "2026-08-10", "to": "2026-08-10", "days": ["2026-08-10"],
             "timezone": "America/Toronto" },
  "config": { "activeGapMinutes": 30, "worklogRoot": "…", "t3BaseDirs": ["…"],
              "claudeProjectsDir": "…" },
  "projects": [ { "key": "t3code", "displayName": "…", "roots": ["…"],
                  "classification": { "include": true, "visibility": "public",
                                      "confirmed": true, "effective": "public" },
                  "stats": { … } } ],
  "unclassified": [ { "key": "…", "displayName": "…", "evidence": { "sessions": 2 } } ],
  "sessions": [ { "key": "t3-<threadId>" | "cc-<sessionId>", "kind": "t3code"|"claude-code",
                  "projectKey": "…", "title": "…", "branch": "…", "models": ["…"],
                  "startedAt": "…", "endedAt": "…", "turnCount": 11,
                  "agentRuntimeMs": 0, "activeMs": 0,
                  "files": [ { "path": "…", "additions": 0, "deletions": 0 } ],
                  "signals": [ "…" ], "tokens": 0,
                  "extract": { … } | null, "needsExtraction": true,
                  "excluded": null | { "reason": "…", "linkedTo": "…" } } ],
  "git": { "repos": [ { "key": "…", "root": "…", "nameWithOwner": "radroid/t3code",
                        "commits": [ { "sha": "…", "at": "…", "subject": "…", "branch": "…",
                                       "files": 0, "insertions": 0, "deletions": 0 } ],
                        "mergedPrs": [ { "number": 66, "title": "…", "url": "…",
                                         "mergedAt": "…", "additions": 0, "deletions": 0 } ],
                        "warnings": ["…"] } ] },
  "stats": { "projectsTouched": 0, "sessions": 0, "turns": 0, "commits": 0, "prsMerged": 0,
             "filesTouched": 0, "linesAdded": 0, "linesRemoved": 0, "tokens": 0,
             "activeMs": 0, "agentRuntimeMs": 0,
             "activeBlocks": [ { "start": "…", "end": "…", "ms": 0 } ] },
  "byDay": { "2026-08-10": { "…stats subset…", "sessionKeys": [], "repoKeys": [] } }
}
```

`--print summary` renders a compact markdown digest of the same data (a few hundred lines at
most) — **that** is what the model reads. `--print json` dumps the bundle. Default: `both`
paths printed, summary to stdout.

## 8. Incremental extraction

Rule: **no message is ever read twice.** Every session gets at most one extract file, holding
a cursor.

- A session is queued only when `needsExtraction` — i.e. it has events newer than its cursor
  **and** clears a materiality bar (a completed turn that touched files, or ≥ 3 tool
  activities, or ≥ 2 user prompts). Days with nothing new cost zero model tokens.
- `worklog extract-queue --bundle B [--limit N]` writes one **slice** per queued session to
  `.worklog-tmp/slices/<key>.md`, containing only: user prompt texts (truncated), assistant
  text (first/last, truncated), deduped tool `detail` lines with paths reduced to basenames,
  file basenames with churn, and commit subjects in-window. **Never tool results.** Hard cap
  ~12 000 chars per slice.
- The skill dispatches one **Haiku** subagent per slice; the subagent returns
  `{problem, approach, outcome, artifacts[], status}`.
- `worklog extract-commit --session KEY --file f.json` validates, merges, advances the cursor,
  and appends the prior outcome to `history[]`.
- The main model then writes the narrative from the summary + extracts only, never raw chat.

## 9. Redaction and the hard gate

`worklog lint --file days/2026-08-10.md` is a **blocking** check (exit 1 on any error):

- absolute home paths, `~/…` paths, email addresses;
- secret shapes: `sk-…`, `ghp_`/`github_pat_`, `AKIA…`, `xox[baprs]-`, PEM headers, ≥ 32-char
  hex blobs;
- any `always_redact` term (case-insensitive);
- the name, `display_name`, or any root basename of a project that is not `public`+confirmed;
- branch names belonging to a non-public project.

The model additionally does a self-check pass (`reference/privacy.md`) before publishing —
lint catches shapes, the self-check catches meaning. Neither substitutes for the other.
Nothing is ever posted anywhere; `worklog publish` only lints and `git commit`s locally.

## 10. CLI surface

| Command                                                                              | Purpose                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worklog doctor`                                                                     | Environment check: databases, `gh` auth, worklog repo, git identity. Never fails the caller.                                                                                      |
| `worklog init [--root DIR]`                                                          | Idempotently scaffold the worklog repo; discover projects; write a registry with **proposed, unconfirmed** entries.                                                               |
| `worklog projects [--json]`                                                          | List registry entries and anything discovered but unclassified.                                                                                                                   |
| `worklog collect --from D --to D [--print summary\|json\|both] [--gap N] [--no-git]` | Build the evidence bundle.                                                                                                                                                        |
| `worklog extract-queue --bundle F [--limit N]`                                       | Emit transcript slices for sessions with new material.                                                                                                                            |
| `worklog extract-commit --session K (--file F \| --json S)`                          | Persist an extract and advance its cursor.                                                                                                                                        |
| `worklog lint --file F`                                                              | Redaction gate. Exit 1 on findings.                                                                                                                                               |
| `worklog publish (--date D \| --range F..T) [--message M]`                           | Lint, then `git add` + `git commit` inside the worklog repo. A range report is a deliverable too; leaving it unpublishable would push the human into running `git` there by hand. |

Every command prints JSON on `--json`, exits non-zero only on real failure, and treats a
missing `gh`, missing database, or offline network as a **warning**, not an error.

## 11. Test strategy

`node scripts/t3x/worklog/test/run.mjs` (add a name to filter: `… run.mjs redact git`).
402 tests. They build throwaway SQLite fixtures with `node:sqlite` and throwaway git repos in
`mkdtemp` dirs — no network, no reliance on the user's real data, no writes outside the temp
dir. `gh` is exercised through an injected runner so the suite never shells out to GitHub.

**Why `*.check.mjs` and not `*.test.mjs`.** This directory is inside the `@t3tools/scripts`
workspace, whose `test` script is vitest, and vitest's default include pattern matches
`*.test.mjs`. It collects such a file, executes it — `node:test` then registers and runs its
cases inline — finds no vitest suite, and fails the package with "No test suite found in
file". Verified, not assumed. The alternative was excluding this directory in the repo's
upstream-owned `vite.config.ts`, which would cost the fork a new seam-ledger row in exchange
for a naming convention. This feature edits **zero** upstream-owned files; keeping it that way
is worth more than the filename.

Two isolation rules the suites depend on, both learned the hard way here:

- **A synthetic bundle must never reach real data.** `extract.queue()` takes its database list
  from `bundle.config.t3BaseDirs` with no fallback to whatever is on the machine, so a test
  bundle without that field reads nothing and says so in a warning.
- **Fixtures live where production refuses to look.** Discovery rejects scratch roots, and
  every `mkdtemp` dir is one, so the suites pass `scratchRoots: []` — and one test deliberately
  does not, to prove the default still rejects `$HOME`, `/tmp` and `/`.
