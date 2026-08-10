# T3X fork homepage — PR #69 evidence

Captured 2026-08-10 against the **deployed** site, <https://t3x-home.businesses.workers.dev>, not a
local preview — so every frame is the artifact that Cloudflare is actually serving. Desktop shots
are 1440x900, mobile shots 390x844 (iPhone 14 Pro), the scroll-through 1280x800.

The hero's mono strip reads `0.0.33-t3x.22 · tracking upstream v0.0.33 · built Aug 10` in these
frames. That text is not authored — it is fetched at page load from the update relay's `/latest`,
so it will read differently in any later capture. That it renders at all is the proof the wiring
works end to end.

| File                                            | What it shows                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `scroll-desktop.gif`                            | Whole page top to bottom. The quickest look.                                |
| `scroll-desktop.mp4`                            | Same, higher quality (1280x800).                                            |
| `08-full-page-desktop.png`                      | Entire page as one still — best for judging overall composition.            |
| `01-hero.png`                                   | Headline, both download buttons, honesty line, **live sync strip**.         |
| `02-fork-graph-main.png`                        | The `main` rail — core product, hollow dots — and the divergence curve.     |
| `03-fork-graph-branch.png`                      | The `t3x` rail — the six fork additions, filled accent-green dots.          |
| `04-harnesses.png` / `05-git.png`               | Upstream's own product demos, kept as-is.                                   |
| `06-open-source.png`                            | "If you don't like something, fork it." — and the fork's answer to it.      |
| `07-cta-footer.png`                             | Final CTA and the fork/upstream attribution footer.                         |
| `09-download.png`                               | `/download` — real version, real byte sizes, real changelog from the relay. |
| `10-404.png`                                    | The 404 page `not_found_handling: "404-page"` serves.                       |
| `11-mobile-hero.png` … `13-mobile-download.png` | The same three surfaces at 390px.                                           |

## What to look for

- **The accent is green, not violet.** One variable diverged from upstream (`--accent-h: 250 → 150`).
  Every fork change is an addition — `+N/-0` on every shared file — and green is the colour of an
  added line.
- **The fork graph's shape is the argument.** `main` carries what T3 Code already does; the `t3x`
  rail visibly branches off it and carries only what this fork adds. Which feature came from where
  is legible from the structure, without a label saying so.
- **Nothing borrowed is presented as ours.** No testimonials, no star or user counts, no store
  listings, no privacy/terms/security pages — those are T3 Tools Inc.'s. The footer links to
  upstream for them.
- **Mobile stacks the two rails flush** and drops the connector curve; the caption alone marks the
  divergence.

## How these were produced

Playwright drove the live URL, waiting on the sync strip to depart from its static fallback before
each homepage shot so no frame captures a pre-fetch state. PNGs are ffmpeg palette-quantized to 256
colours — lossless in practice for flat dark UI, and roughly half the bytes.
