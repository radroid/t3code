# The report format

## The day file template

Copy this exactly. Drop any section that has nothing to say — an empty heading is worse than
a missing one.

```markdown
# YYYY-MM-DD

<One line: the day in a sentence. What the day was about, not "worked on several things".>

> Heads-up line — only when the summary reports unclassified projects. Wording below.

## <Project or theme>

<One to three short paragraphs. The problem, what you tried, what ended up true.
Name files by basename, link PRs by number.>

## <Second project or theme>

<Same shape.>

## Also

- <One line per thing too small for its own section.>
- <One line.>

---

_<stat garnish line>_
```

Rules for the parts:

- **H1 is the ISO date, nothing else.** Tools key off it.
- **The one-liner is the whole report for most readers.** Write it last, from what you
  actually wrote.
- **Sections are ordered by what mattered**, not by commit count or time spent.
- **The heads-up line** appears directly under the one-liner whenever the summary carries an
  **Unclassified projects** or an **Unconfirmed projects** section. Both mean the same thing to
  a reader — work happened that this report does not describe — and both must be declared, or
  the omission is undetectable:
  `> Some work is left out: 2 projects are not yet confirmed. Run worklog classify to include them.`

  Count both sections together. Never name the projects in this line — naming them is the very
  thing their classification forbids.

- **The stat line is the last line**, italic, after a `---`. It is garnish.

## Voice

Narrative-led. Every section answers three questions in order: what problem, what approach,
what shipped. If a paragraph does not answer one of them, it is filler.

**Do:**

- Past tense, first person, plain words. "I found", "it broke", "that fixed it".
- Specific over grandiose. "The notify call 500'd after the publish had already committed"
  beats "improved release reliability".
- Say what broke and what it cost when that is the interesting part. A two-hour dead end is
  a better sentence than a clean feature.
- Name the real thing: a function, a file basename, a PR number, an error.
- Let a day be small. "One bug, three hours, one line" is a fine report.

**Don't:**

- No throat-clearing. Never open with "Today I focused on", "Here's a summary of", or
  "It was a productive day".
- Banned words: leveraged, delve, journey, robust (as a compliment), seamless, comprehensive,
  utilize, deep dive, unlock, streamline, "at the end of the day".
- No em-dash-and-adjective triplets. No "not just X, but Y".
- Numbers are garnish, not the point. A paragraph whose subject is a token count is a
  paragraph about nothing.
- No transcript quotes, ever. No code blocks longer than three lines — describe instead.
- No hedging about what the tooling could not see. If a stat is missing, leave it out
  silently; do not narrate the gaps.

## The stat garnish line

One italic line, `·` separated, in this order, with both time numbers side by side and each
glossed in one clause:

```markdown
_2 projects · 3 PRs merged · 21 commits · 12 sessions · 5h 40m active (hands-on-keyboard, gaps over 30m dropped) · 31h 12m agent runtime (turn wall-clock, parallel sessions added together)._
```

- Omit any stat that is zero or absent. Zero PRs merged is not worth a slot; a missing `gh`
  means the PR slot does not appear at all.
- Never put files touched, lines changed, or tokens in this line — the first two are soft in
  both directions (see `data-model.md`) and the third means nothing to a reader.
- **Gloss agent runtime as wall-clock, not as effort.** It is the sum of per-turn spans and
  parallel sessions add together, which is why it outruns the day. A span runs from a turn's
  start to its finish regardless of what happened in between, so time the turn spent waiting
  is inside it wherever the record does not prove otherwise — including a turn parked at an
  approval prompt with nobody at the desk. "Machine time I directed" claims more than the
  number can carry: it counts waiting as working. Say what it measures and let it stay
  garnish.
- Round times to the minute below an hour, to five minutes above it.

## Worked example

Fictional projects. Use it for shape and tone, not content.

```markdown
# 2026-08-10

Chased a release that reported failure after it had already succeeded, and fixed the notifier
that lied about it.

## Tidepool

The 4.2 release went out and the pipeline went red. The publish step had committed the
manifest, the artifact was live, and the download endpoint was serving the new build — but
the notify step returned a 500 and took the whole run down with it. Every dashboard said the
release had failed. It had not.

The notifier posts to a small edge worker that fans out to subscribers. The worker throws
roughly one request in a few hundred, and the notifier treated any non-2xx as fatal. Worse,
the prune step ran after notify, so a transient blip also skipped cleanup — the failure was
one bad response wide and two steps deep.

Added three retries with backoff, and taught the worker to turn an internal exception into a
503 with a body naming the subscriber that failed, so a red run is readable now instead of
just red. Moved prune ahead of notify. Verified against the live endpoints before and after:
both already had the correct build, which is the whole point. Shipped as #66.

## Quill

Spent an hour on a phantom test failure before noticing the suite passed locally and failed
in CI for a boring reason: the fixture writes into a temp directory and CI runs two jobs in
the same container. Gave each job its own prefix. No interesting insight, just an hour.

## Also

- Reviewed and merged #64, a docs-only change.
- Filed a follow-up on the armed auto-restart: it lives in one renderer and does not survive
  a reload, so a second window never sees it.

---

_2 projects · 2 PRs merged · 14 commits · 7 sessions · 5h 10m active (hands-on-keyboard, gaps over 30m dropped) · 22h 40m agent runtime (turn wall-clock, parallel sessions added together)._
```

Note what the example does: it names the failure precisely, admits the wasted hour without
dressing it up, and puts the numbers last where they belong.

## The range file

`ranges/<from>..<to>.md`, written from the day files you just produced — not from a fresh
collect, and not from the bundles.

```markdown
# YYYY-MM-DD .. YYYY-MM-DD

<The through-line: one paragraph. What this stretch was really about, what changed between
the first day and the last, what is still open. This is the only part anyone reads.>

## Days

- **Mon 04** — <one line, lifted and tightened from that day's one-liner>
- **Tue 05** — <one line>
- **Wed 06** — <one line>
- **Thu 07** — nothing substantial.
- **Fri 08** — <one line>

## Landed

- <PR or shipped thing, one line each — only the ones a reader would care about>

## Still open

- <One line each, only if genuinely carried forward.>

---

_<stat garnish line, summed across the range — sessions, commits, PRs, active time and agent
runtime all add; projects touched is the union, not the sum.>_
```

The through-line is the work. Resist writing five paragraphs that restate five days — if the
week had no shape, say that in one honest sentence and let the day list carry it.
