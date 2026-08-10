# Coil homepage — PR #69 evidence

Captured 2026-08-10 against the **deployed** site, <https://coil.curlycloud.dev>, not a local
preview. Desktop 1440x900, mobile 390x844, scroll-through 1280x800.

Replaces the earlier `2026-08-10-fork-homepage/` capture set, which documented the retired T3X
version of this page.

The hero's mono strip reads `0.0.33-t3x.22 · tracking upstream v0.0.33 · built Aug 10`. It still
says `t3x` because that is what the release pipeline publishes today — the site was renamed, the
release identity was not. Issue #71 covers that, and it is deliberately out of scope here.

| File                 | What it shows                                                          |
| -------------------- | ---------------------------------------------------------------------- |
| `scroll-desktop.gif` | Whole page top to bottom. The quickest look.                           |
| `scroll-desktop.mp4` | Same, higher quality.                                                  |
| `05-full-page.png`   | Entire page as one still.                                              |
| `01-hero.png`        | Coil, the first-person framing, and the live sync strip.               |
| `02-today.png`       | "What's here today" — six shipped things, solid grid.                  |
| `03-next.png`        | "Where this is going" — dashed cards, `planned` tags, nothing claimed. |
| `04-ask.png`         | The feature-request CTA.                                               |
| `06-download.png`    | Real version, real byte sizes, real changelog from the relay.          |
| `07-404.png`         | The 404 page.                                                          |
| `08-` … `11-`        | Hero, roadmap, download and CTA at 390px, after the mobile fix.        |

## What to look for

- **First person throughout.** No "we", no "community", no "contributors". The one remaining "we"
  in upstream's harnesses copy was changed to "it" — on a personal fork page, "we orchestrate them"
  had no clear referent.
- **The two sections look different on purpose.** Shipped work is a solid bordered grid; planned
  work is dashed, muted, and tagged. Nothing in the roadmap should read like something you can
  download, so it does not share the shipped section's styling.
- **The roadmap says it is unbuilt three times** — in the preamble, on every card, and in the
  border style. Loops are the direction, not a feature.
- **Gone:** the fork graph, and the "If you don't like something, fork it" section. The second was
  redundant on a page that is itself a fork.

## Mobile fix, 2026-08-10

The first mobile capture showed upstream's five floating harness marks colliding with this hero,
which is taller than the one they were positioned against: `hf-grok` over the headline (3,468 px²)
and `hf-opencode` / `hf-cursor` over the download buttons (~5,700 px² each) at 390px. The three that
collide are now hidden below 820px; the two top-corner marks stay. Separately, the button rows
wrapped to their content widths — a 217px button above a 133px one — and now stack as one column at
equal width below 480px. Re-measured at 320, 390 and 430: zero overlap, equal widths, no overflow.

## How these were produced

Playwright drove the live URL, waiting for the sync strip to depart from its static fallback before
each homepage shot so no frame captures a pre-fetch state. PNGs are ffmpeg palette-quantized to 256
colours.
