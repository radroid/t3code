# What the evidence can and cannot tell you

You never touch these sources directly — the collector does. This page exists so you know
what a number in the summary actually means before you build a sentence on it.

## The four sources

### T3code SQLite (`~/.t3/*/state.sqlite`)

**Can tell you:** thread titles, which project a thread belongs to, the branch, per-turn
timing, model used, an activity feed of what tools ran, and the raw chat.

Thread titles are model-generated and genuinely descriptive — "Sync fork with upstream and
verify release" — so they are the single best free signal in the whole system. Lead with them.

**Cannot tell you:** which Claude Code session a thread drove (the link column is NULL for
every row), or reliably which worktree it ran in (`worktree_path` is populated for well under
a tenth of threads). Never write "in the X worktree" from this data.

### Claude Code logs (`~/.claude/projects/**/*.jsonl`)

**Can tell you:** when a standalone (non-T3code) session ran, its `cwd` and git branch, the
first real user prompt, and any PRs opened during it (`pr-link` records are free and exact).

**Cannot tell you:** a title. This user's history contains **no `summary` records**, so a
Claude Code session has no name — its identity is its first prompt plus whatever git evidence
lines up with it. Do not expect the summary to hand you a headline for these.

### git

**Can tell you:** commits in the window with subject, branch and churn, per repo. Authored by
the user only — the registry's `identities` list decides that.

**Cannot tell you:** anything about a repo the registry does not know a root for. Worktrees of
one repo collapse into a single entry, so three t3code worktrees are one repo, not three. It
also cannot tell one rebase copy from another — see "Commits are patches, not SHAs" below.

### `gh`

**Can tell you:** merged PRs with number, title, URL and churn.

**Cannot tell you:** anything if `gh` is missing, unauthenticated, or offline — in which case
merged PRs are simply **absent, not zero**. If the summary carries a `gh` warning, do not
write "no PRs merged"; write nothing about PRs. It also cannot tell you _whose_ PR it is
unless the registry knows your GitHub login; see below.

## The four traps

**1. `summary` on an activity is a generic label, not a description.**
The stored value is "Command run" / "File change" / "Task completed". It says nothing. The
real content lives in the payload, and the collector has already pulled the useful part into
the session's `signals` and `title`. If a summary line reads like boilerplate, it is
boilerplate — do not quote it back as if it were a finding.

**2. Token usage is cumulative per task, not per event.**
Each progress event restates the running total for its task. The collector takes the max per
task and sums those. You will never need to do this arithmetic — but it is why token numbers
are not additive across rows, and why you should not try to "check" them by eye against
anything.

**3. A T3code session is also a Claude Code session.**
T3code drives Claude Code, so the same work is recorded twice. The collector links them (by
worktree, then by a hash of the first prompt) and marks the duplicate
`excluded: {reason: "t3code-driven"}`. Two consequences:

- The session count in the summary already excludes duplicates. Use it as printed.
- If you see two sessions that look like the same work and neither is excluded, the join
  missed. Say "sessions" cautiously, or describe the work once and skip the count.

**4. Most "sessions" on a busy day are machines talking to themselves.**
Generating a thread title, generating a branch name, running an automated security review, and
pinging a provider each open a real Claude Code session in a real workspace. On the first day
this was run against real data, 13 genuine threads presented as 43 sessions — the majority of
them title generation. The collector marks these
`excluded: {reason: "machine-generated"}` and they are already out of the printed count.

The rule that matters for you: **if a session's headline reads like an instruction to a model
rather than a request from a person — "Generate a title…", "Review this change for…" — it is
not work.** It is never a thing the user did, and it never belongs in the narrative, even when
it survived into the summary because nobody had seen that prompt before.

## Which stat comes from where

| Stat                         | Source                                          | Trust                                                |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Projects touched             | registry match on session cwd / repo root       | Good; excludes `include: false`                      |
| Sessions                     | T3code threads + unlinked Claude Code sessions  | Good after dedup                                     |
| Turns                        | T3code `projection_turns`                       | T3code only — Claude Code turns are not counted here |
| Commits, lines added/removed | `git log` in known repo roots                   | Good; your identities only, known roots only         |
| PRs merged                   | `gh`                                            | **Absent** without `gh`; yours only with a login     |
| Active time                  | merged event timeline, split on a 30-minute gap | Good; a floor, not a stopwatch                       |
| Agent runtime                | Σ per-turn and per-prompt spans                 | Wall-clock, not effort — see below                   |
| Files touched                | turn checkpoints + git                          | **Wrong in both directions**                         |
| Tokens                       | activity payloads, max-per-task summed          | Directional only                                     |

## Where the numbers are soft

- **Files touched — wrong in both directions, so never report the count.** Roughly 62% of
  turns record no file list at all, so plenty of real edits are simply missing. And the lists
  that do exist are a diff between two workspace snapshots, so anything else that moved the
  tree between turns lands in them: a branch switch, a `git pull`, a rebase landing in another
  worktree. Files the session never touched are counted; files it did touch are dropped. The
  figure is neither a floor nor a ceiling. Name the two files that actually mattered, or say
  nothing.
- **Merged PRs may not be yours.** `gh pr list` returns everything merged in the repo. The
  collector filters to your GitHub login, but it can only find that login in the registry's
  `identities` — as an explicit `@login`, a bare login, or the local part of a
  `…@users.noreply.github.com` address. With none of those, nothing is filtered and the
  summary says so in a warning. On a repo with other contributors, an unwarned PR count is
  yours; a warned one is the repo's. Read the warning before you write a number.
- **Commits are patches, not SHAs.** A rebase or a cherry-pick copies a commit, keeping its
  author, author date and subject and changing only the SHA — and on this fork both copies stay
  reachable, so counting SHAs double-counts every sync. The collector therefore dedupes on
  author + author date + subject. Consequence: the count is "pieces of work", and two genuinely
  distinct commits by one author in the same second with the same subject collapse into one.
- **Tokens.** Only T3code tasks report usage, and only some of them. It is a rough sense of
  scale, never a headline. If you find yourself leading a paragraph with a token count, cut
  it.
- **Agent runtime is wall-clock, not work done.** It sums per-turn spans, and parallel sessions
  add together, so it can exceed 24 hours in a day — that part is correct, not a bug. But a
  span runs from a turn's start to its finish regardless of what happened in between, so idle
  stretches are inside it wherever the record does not prove otherwise: a turn that stopped to
  ask for approval and waited overnight is billing that night. Treat it as an upper bound on
  agent activity, never as effort and never as your own time. Report it beside active time and
  gloss it (see `report-format.md`) so nobody reads "31h" as a workday.
- **Active time is a floor.** Thinking at a whiteboard, reading, and meetings leave no events.
  A day with two hours of active time may still have been a full day of work.
- **Claude Code sessions have no title.** Their headline has to come from the extract, or from
  the commits that landed alongside them.
