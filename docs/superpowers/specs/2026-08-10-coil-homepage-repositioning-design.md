# Coil — homepage repositioning design

**Status:** approved in brainstorming 2026-08-10. Supersedes the positioning in
`docs/superpowers/plans/2026-08-10-t3x-homepage-cloudflare.md`, which shipped as PR #69. The
infrastructure that plan built — the Astro copy, the Cloudflare Worker, the relay-backed downloads,
the CI deploy — all stands. This changes what the page _says_ and which sections exist.

## Why

The shipped page presents the fork as a community project called T3X, led by its feature list. Three
things are wrong with that. The fork is one person's: **Curly Cloud** builds it against their own
daily workflow and publishes it so other people can ask for what _their_ work needs. The direction
that matters — loops, skills, building in public — is nowhere on the page. And a section inviting
the reader to fork the project is redundant on a page that is itself a fork.

## Decisions

| Decision          | Choice                            | Why not the alternative                                                                                                                                                                                                                      |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name              | **Coil**                          | A coil is both a curl and a loop, tying the Curly Cloud handle to the roadmap in four letters. `Cirrus` was the near-miss — Latin for "a curl", and a cloud type — but Cirrus CI is an established dev-tooling brand and this is a dev tool. |
| Voice             | First person singular             | "We" and "the community" describe a project that does not exist. One person builds this.                                                                                                                                                     |
| Loops on the page | Roadmap section, tagged `planned` | Loops lead the _direction_, not the feature list. Nothing loop-related has shipped: `docs/coil/loop/` is design-only, archived in `67fb23e81` when its branch was deleted.                                                                   |
| Page spine        | Two plain sections                | "What's here today" and "Where this is going". The fork graph is retired.                                                                                                                                                                    |
| Long-term vision  | Plain language, no jargon         | "Forward deployed engineer" is precise for the few and opaque to everyone else.                                                                                                                                                              |
| Domain            | `coil.curlycloud.dev`             | The product is Coil, so `t3.` would be stale on arrival.                                                                                                                                                                                     |
| Accent            | Green stays (`--accent-h: 150`)   | Chosen. The original rationale — green is the colour of an added line — lived visually in the fork graph and leaves with it, but the colour works and the fork is still additive.                                                            |
| Rename scope      | Landing site only                 | Everything else is issue #71, which carries the two hazards that make it non-trivial.                                                                                                                                                        |

## Non-goals

- Renaming the fork's release identity, relay, source directories, workflows, or docs. Issue #71.
- Changing the download mechanism, the Worker setup, or the CI deploy. They work.
- Claiming loops, skills, or build-in-public exist. They do not.

## Page structure

```
nav: Coil ───────────────────────────────── GitHub
HERO
  h1: Coil
  h2: T3 Code, the way I actually run it.
  sub: personal fork line + upstream credit
  [Download for macOS] [Windows]
  unsigned-builds honesty line
  live sync strip (unchanged)
  direction teaser: "Heading toward loops, skills, and building in public."
  screenshot
WHAT'S HERE TODAY ────── the 6 verified-shipped items, first person
WHERE THIS IS GOING ──── near term (3, tagged `planned`) + further out
HARNESSES ────────────── upstream's demo, kept as-is
GIT ──────────────────── upstream's demo, kept as-is
ASK FOR SOMETHING ────── feature-request CTA
CTA + footer
```

**Cut:** the fork-graph section (`#fork-graph`) and the open-source "If you don't like something,
fork it" section (`#open`), plus their CSS.

**Kept unchanged:** `#harnesses`, `#git`, the download page, the 404 page, the hero screenshot, and
the relay-backed sync strip.

## Copy

### Hero

> # Coil
>
> ## T3 Code, the way I actually run it.
>
> A personal fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT) by Curly Cloud. I use it
> every day and keep it rebased on upstream — everything upstream ships, plus the things I wanted
> sooner.
>
> _Heading toward loops, skills, and building in public._

"Heading toward" is load-bearing. It states the core message as a direction, which is true, rather
than as a capability, which would not be.

### What's here today

The six items already verified as merged on `origin/main`, reworded to first person. Content is
unchanged from the shipped page except for voice and the correction already made in PR #69 ("Web
Push + tolerant reconnect", not "keepalive" — PR #25 shipped a reconnect supervisor).

### Where this is going

Each near-term item carries a visible `planned` tag. The section preamble says plainly that none of
it is built yet.

- **Loops** — agents that keep working through a task instead of stopping at every turn. Tracked in
  issue #42.
- **Skills** — reusable procedures the agent picks up, instead of re-explaining the same workflow.
- **Build in public** — the work visible as it happens, not summarised afterwards.

Further out:

> The workflows I'm aiming at are the ones where you're dropped into someone else's codebase, on
> their constraints, and expected to ship in their environment.

### Ask for something

> I build this against my own workflow. If you want it to fit yours, open a feature request — that's
> the fastest way to get something built.

Links to `https://github.com/radroid/t3code/issues/new?template=feature_request.yml`. Issues are
enabled on the fork and that template exists; Discussions are not enabled.

### Final CTA

The shipped copy reads "T3X is free, open source, and current with upstream." Becomes:

> ## Your agents deserve better than a terminal.
>
> Coil is free, open source, and rebased on upstream every day. Install it, plug in the harness you
> already pay for, and let your agents get to work.

### Chrome

- Nav brand: `Coil`, `aria-label="Coil home"`.
- Title: `Coil — a T3 Code fork`. Description: `Coil — a personal fork of T3 Code by Curly Cloud,
with auto-updates, push notifications, and a daily upstream sync.`
- Footer: `© {year} Curly Cloud · MIT · a fork of T3 Code by T3 Tools Inc`.
- The terminal mock in `#open` goes with that section; no other mock references the old name.

## Rename scope, precisely

In scope — the landing site and nothing else:

- Copy, nav, footer, meta, OG/Twitter tags.
- Package `@t3tools/t3x-home` → `@t3tools/coil-home`; directory `apps/t3x-home` → `apps/coil-home`.
- Worker `t3x-home` → `coil-home`; `wrangler.jsonc` gains the `coil.curlycloud.dev` custom domain.
- Workflow `t3x-deploy-home.yml` → `coil-deploy-home.yml`, including its `paths:` filter and its
  live-site verification URL.
- The `SEAMS.md` parallel-path note and the sync-runbook item, which both name `apps/t3x-home`.

Out of scope: everything in issue #71.

**Do not rename `MANIFEST_URL` in `src/lib/releases.ts`.** It points at
`https://t3x-update-relay.businesses.workers.dev/latest`, which is the live relay serving every
installed desktop build. It is `t3x`-named and it stays that way until issue #71 migrates it. A
find-and-replace across `apps/coil-home/` would silently point the download buttons at a hostname
that does not exist. The `CACHE_KEY` beside it is site-local and may be renamed freely.

Full occurrence audit of the current site source, so nothing is missed and nothing is over-reached:
12 in `index.astro` (6 of them inside the two sections being cut), 7 in `Layout.astro`, 4 in
`404.astro`, 3 in `download.astro`, 3 in `releases.ts` (**two of which are the relay URL and must
not change**), 2 in `wrangler.jsonc`, 2 in `package.json`, 1 in `astro.config.mjs`.

### Cutover notes

- Renaming a Worker creates a new one; `t3x-home` lingers until deleted. Delete it after
  `coil.curlycloud.dev` serves, and accept that `t3x-home.businesses.workers.dev` dies with it. No
  installed software depends on that hostname — unlike the relay in issue #71, which does.
- `astro.config.mjs` `site:` becomes `https://coil.curlycloud.dev`, which is what canonical and OG
  URLs are built from.
- The custom domain needs the `curlycloud.dev` zone on the same Cloudflare account. It is —
  verified 2026-08-10.

## Verification

- Every feature claim in "What's here today" re-checked against `origin/main` before commit. This is
  the rule that caught the keepalive error in PR #69.
- No claim in "Where this is going" written in the present tense.
- `grep` shows no `T3X`, `t3x`, "community", or "we" surviving in `apps/coil-home/src`.
- `apps/marketing` diff stays empty.
- Build, typecheck, and a browser pass at 1440px and 390px, as in PR #69.
- `coil.curlycloud.dev` returns 200; the old `/download` and `/nope` behaviours still hold.
