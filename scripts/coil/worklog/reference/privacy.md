# Privacy: what may be named, and how to check

The asymmetry that decides every call here: a false negative is unrecoverable — a client name,
once posted, stays posted — while a false positive costs one edit. When in doubt, say less.

## The visibility table

Every project in `config/projects.yaml` carries `include`, `visibility` and `confirmed`. Those
three fields collapse into one **effective** state:

| State                              | Named?             | Described?                           | Counted in stats?                         |
| ---------------------------------- | ------------------ | ------------------------------------ | ----------------------------------------- |
| `public` + `confirmed: true`       | Yes, with its link | Yes, freely                          | Yes                                       |
| `generic` + `confirmed: true`      | No                 | Yes, anonymised — "a client project" | Yes                                       |
| `private` + `confirmed: true`      | No                 | No                                   | Yes                                       |
| Any visibility, `confirmed: false` | No                 | No                                   | Yes, **and flagged in the report header** |
| `include: false`                   | No                 | No                                   | No                                        |
| Not in the registry at all         | No                 | No                                   | No                                        |

Two things people get wrong:

- **`private` still counts.** The hours, sessions and commits land in the totals; only the
  description is withheld. That is the point — the day's shape stays honest.
- **Unconfirmed is not "probably fine".** It means no human has ever reviewed it. Treat it
  exactly as `private`, and add the heads-up line from `report-format.md` so the reader knows
  the report is partial.

## Generation rules

- **Public + confirmed:** name it, link it, name its files by basename, cite PR numbers, quote
  branch names if they add something. Normal engineering writing.
- **Generic + confirmed:** describe the work with the subject removed. "A client project" /
  "a consulting engagement" / "an internal tool". Keep the technical substance — the bug, the
  approach, the fix are all publishable. Strip: the client name, the product name, the repo
  name, the domain, distinctive feature names, branch names, and any file path specific enough
  to identify the codebase. A generic section that describes a real problem well is more
  interesting than a named section that says nothing.
- **Private / unconfirmed:** no section, no bullet, no adjective. It contributes to the
  numbers and nothing else. Do not write "also spent time on other work" — that is a hint, and
  hints are what people reconstruct from.
- **Anything you cannot place:** if a session's project is not in the registry, it does not
  exist for narrative purposes. Do not infer a project from a branch name or a file basename.
- **Cross-project leakage:** a public section must not describe a private one by contrast
  ("unlike the other client's setup…"). Check that your public paragraphs stand alone.

## The always-redact list

`config/redaction.yaml` holds terms that must never appear, plus the neutral phrase to use
instead:

```yaml
version: 1
always_redact:
  - Northwind Retail
replacements:
  Northwind Retail: a retail client
```

`worklog lint` matches these as **plain substrings, case-insensitively, anywhere in the file**.
Precisely:

- **Inside longer words and tokens.** `northwind` fires in `northwindretail-prod` and in
  `Northwinds`. That is deliberate: a client name reaches a public post inside a deployment
  slug far more often than as a tidy standalone word, and a false positive costs one edit
  while a miss cannot be undone.
- **Inside links, code spans and fenced blocks.** There is no exemption for URLs here, even
  for public code hosts — a term on this list is the leak wherever it sits.
- **Across whitespace.** Spaces inside a term match any run of whitespace, so
  `Northwind Retail` still matches when a line wrap splits it.

It is a blocking error. The same matcher scrubs transcript slices on their way to disk, so a
term on this list never reaches a subagent either. The `replacements` map is not applied
automatically to your draft — it tells you what to write instead. If you find yourself
needing a term that is on the list, the answer is the replacement, never the term.

The cost of substring matching: do not put a short or common word on this list. `app`, `api`
or a two-letter client initialism will fire on every other line, and a gate the user learns to
skim past is a gate that is off. Use the longest distinctive form of the name. (Project names
taken from `config/projects.yaml` are matched the same way, but only when they are at least
four characters — short registry keys like `cli` are skipped for exactly this reason.)

If you discover during a report that a name should be on the list and is not, tell the user
and offer to add it. Do not add it yourself mid-report and carry on as if that settled it.

## Rewriting a leaky sentence

**Before:** "Fixed the Northwind Retail checkout flow — their Stripe webhook was double-firing
on `/Users/raj/Developer/northwind/src/api/webhooks/stripe.ts`, so orders were duplicated."
**After:** "Fixed a duplicate-order bug at a retail client: their payment webhook fired twice
for one event, and the handler had no idempotency key. Added one keyed on the event id."
_Removed: client name, home path, repo name. Kept: the actual bug and the actual fix._

**Before:** "Two sessions on `feat/acme-sso-saml`, mostly untangling their Okta metadata."
**After:** "Two sessions on SSO for a client — most of it was untangling how their identity
provider serialises federation metadata, not the integration itself."
_Removed: branch name (carries the client), vendor name that identifies them in context._

**Before:** "Shipped the v2 dashboard for the client, plus some work on my own stuff."
**After:** "Shipped a dashboard rewrite for a client."
_Removed: "some work on my own stuff" — a private project should leave no trace in prose,
and vague gestures at hidden work invite guessing._

**Before:** "Debugged a crash in `apps/server/src/coil/relay/notify/handler.ts`, reachable at
`~/Developer/t3code`."
**After:** "Debugged a crash in the relay's notify handler (`notify.ts`)."
_Removed: the deep path and the home path. A basename locates the file for anyone with the
repo; the tree above it maps the author's machine._

## Self-check, before you lint

Run these against your own draft, question by question. Every honest "no" is a rewrite, not a
justification. Lint catches shapes; only you can catch meaning.

1. Does every project I **named** appear in the registry as `public` **and** `confirmed: true`?
2. Does every project I **described** appear as `public` or `generic`, and confirmed?
3. Did any private or unconfirmed project leave a trace — a sentence, a bullet, an "also",
   a hint that there was other work?
4. If the summary listed unclassified projects, is the heads-up line in the header?
5. Could a reader who knows the industry identify a `generic` client from what I wrote — from
   a product name, a vendor, a distinctive feature, a team size, a domain, or a timeline?
6. Is there any absolute path, any `~/` path, or any path deeper than two segments?
7. Is there an email address, a handle that resolves to one, or a personal URL?
8. Is there anything shaped like a credential — a token, a key, a long hex string, a JWT
   (`eyJ…`), an `Authorization:` header, a `token=` or `password=` line?
9. Is there any quoted chat, prompt text, tool output, or a code block longer than three lines?
10. Is every branch name I mention attached to a project that is public and confirmed?
11. Does every claim trace to the summary or a committed extract — nothing invented, nothing
    inferred from a file name?
12. Would the user be comfortable if this appeared, unedited, on their public timeline?

If a question is uncomfortable rather than clearly answerable, cut the sentence. The report
loses less from a missing sentence than the user loses from a wrong one.
