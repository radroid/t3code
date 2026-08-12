# T3X Fork Homepage on Cloudflare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fork-owned homepage (seeded from upstream's `apps/marketing` Astro site) that presents the T3X fork honestly, serves working download links from the fork's release pipeline, and deploys to Cloudflare Workers static assets — first manually, then automatically on every push to `main`.

**Architecture:** Copy `apps/marketing` into a new fork-owned package `apps/t3x-home` (never edit `apps/marketing` — the seam ledger's additive invariant is the fork's sync safety, and a 1310-line in-place rebrand would conflict on every upstream marketing change). Rebrand the copy, replace the GitHub-API release lookup (which 404s on the fork — all fork releases are pre-releases) with the already-live update-relay manifest, and serve the built `dist/` as an assets-only Cloudflare Worker named `t3x-home`, mirroring the existing `infra/coil-update-relay` conventions.

**Tech Stack:** Astro 7 (static output), pnpm workspace (`apps/*` glob — the new package auto-joins), Cloudflare Workers static assets via `wrangler.jsonc`, `pnpm dlx wrangler@4` (never installed as a dependency), GitHub Actions (`ubuntu-latest` + `voidzero-dev/setup-vp@v1`, matching `coil-ci.yml`).

## Global Constraints

- **NEVER modify anything under `apps/marketing/`.** It is upstream-owned. All work happens in the new `apps/t3x-home/`.
- **Never add `wrangler` as a dependency.** Always invoke via `pnpm dlx wrangler@4 <cmd>`. Reason (verbatim from `infra/coil-update-relay/package.json`): it drags ~500 lines into `pnpm-lock.yaml`, the fork's second-worst rebase-conflict surface.
- **Do not touch the `overrides:` block in `pnpm-workspace.yaml`** when `pnpm install` regenerates the lockfile — it carries the security sweep.
- **Branch off a freshly fetched `origin/main`** (`git fetch origin` first — the daily sync automation force-rewrites `main`; a stale base means unmergeable work). Branch name: `t3x/homepage`.
- **Only advertise shipped features.** Verify each claimed feature exists on `origin/main` before writing it into page copy (Task 3 lists the vetted set). Loop Watch, the worklog skill, and the #42–#45 backlog are NOT shipped — never mention them.
- **Do not republish upstream's social proof or legal pages.** The tweets/pfps testimonials, "100,000 devs" / "14k+ stars" stats, privacy policy, terms of service, security policy, and legal pages describe T3 Tools Inc.'s product and company — presenting them as the fork's would be dishonest. Strip them; link to upstream instead.
- **Fork identity strings (use verbatim):** name **T3X**, GitHub `https://github.com/radroid/t3code`, upstream credit `https://github.com/pingdotgg/t3code`, site URL `https://t3x-home.businesses.workers.dev`, update manifest `https://t3x-update-relay.businesses.workers.dev/latest`.
- Package name: `@t3tools/t3x-home`. Worker name: `t3x-home`. Workflow file: `.github/workflows/t3x-deploy-home.yml`.
- Commit after every green task. Prefix commits `feat(t3x):` / `docs(t3x):` / `ci(t3x):` as appropriate.

## Design & content spec

This section is the visual and editorial contract for Tasks 3–4. The executor implements it exactly; where it is silent, match the existing `apps/marketing` idiom rather than inventing.

### Design stance

The fork **inherits upstream's visual system deliberately** — it ships the same product, and the site should look like the app does. Do not redesign: keep the near-black theme (`--bg: #09090b`), the DM Sans display/body + JetBrains Mono utility pairing, the noise overlay, the 12px radii, and the existing section/card CSS. The fork's identity comes from three deliberate divergences, and only these:

1. **The accent hue flips from violet to diff-green.** In `Layout.astro`, change one line: `--accent-h: 250` → `--accent-h: 150`. Everything derived (`--accent`, `--accent-dim`) follows. Rationale, which is also the site's story: this fork's entire sync discipline is that every change is an _addition_ — `+N/-0` on every shared file — and green is the color of added lines in a diff. One variable diverged from upstream is also, fittingly, the smallest possible fork.
2. **A live sync strip in the hero** (the page's signature, wired in Task 4): a single mono-type line under the download buttons, populated client-side from the update-relay manifest — `` `0.0.33-t3x.20 · tracking upstream v0.0.33 · built Aug 10` `` (version and date from `fetchLatestManifest()`; derive the upstream version as `manifest.version.split("-t3x")[0]`). Static fallback text if the fetch fails: `Rebased onto upstream daily`. This makes the fork's core promise — _always current with upstream_ — a verifiable, self-updating fact rather than a claim.
3. **The fork graph section** (below), which replaces the deleted endorsements section as the page's second act.

Nav brand becomes `T3X` (keep the `nav-brand` markup shape); the nav's GitHub-stars pill becomes a plain `GitHub` link to the fork (no star count — those stars are upstream's). Footer brand line: `© {year} T3X contributors · MIT · a fork of T3 Code by T3 Tools Inc` with the T3 Code words linking to `UPSTREAM_REPOSITORY_URL`. Footer links: GitHub (fork), Download, Upstream (T3 Code repo). Drop the Discord and store links — that community and those listings are upstream's.

### Page map

```
┌ nav: T3X ──────────────────────────────── GitHub ┐
│ HERO (kept, recopied)                            │
│   h1: T3X headline · sub: fork-of-T3-Code line   │
│   [Download for macOS] [Windows]                 │
│   mono sync strip: 0.0.33-t3x.20 · tracking …    │
│   screenshot.webp                                │
├ FORK GRAPH (new — replaces endorsements) ────────┤
│   h2: Everything T3 Code is. Plus a branch.      │
│   main ○ Every agent, one workspace              │
│   main ○ Bring your own sub                      │
│   main ○ ⌘⏎ Commit, push, PR                     │
│   main ○ MIT open source                         │
│        ╲                                         │
│   t3x   ● Auto-updates                           │
│   t3x   ● Needs-input notifications              │
│   t3x   ● Web Push + keepalive                   │
│   t3x   ● Auto-resume                            │
│   t3x   ● Daily upstream sync                    │
│   t3x   ● Dependency security sweep              │
├ HARNESSES (kept as-is: "Bring your own sub") ────┤
├ GIT (kept as-is: one-button commit/push/PR) ─────┤
├ OPEN ("fork it" section, recopied — see below) ──┤
├ CTA (kept, download links from manifest) ────────┤
└ footer ──────────────────────────────────────────┘
```

The kept sections (`#harnesses`, `#git`, and the CTA) are the core product's deep-dive demos — that is how the page "clearly shares the core product's features": by keeping upstream's own demonstrations of them, not by paraphrasing them into a bullet list.

### The fork graph (signature section)

A vertical git-graph: one `main` rail carrying the core product's features as hollow commit dots, and a `t3x` branch rail diverging from it carrying the fork's additions as filled accent-green dots. Structure encodes truth: which features come from where, and (via a caption at the divergence point: `rebased onto upstream daily`) that the branch never drifts. Build it as semantic HTML — two `<ol>` lists with CSS-drawn rails (borders/pseudo-elements, no images or JS); dots are `::before` circles; the branch rail and its dots use `var(--accent)`. Mobile: the two rails stack vertically (main list, then branch list) with the connector hidden. Respect `prefers-reduced-motion`; at most a single scroll-triggered reveal of the branch rail, no scattered animations.

Card copy, verbatim (title — one-liner):

`main` rail (core product — these restate what the kept demo sections show):

- **Every agent, one workspace** — Threads from all your coding agents, side by side in one control plane.
- **Bring your own sub** — Plug in Claude Code, Codex, or OpenCode. T3 Code doesn't resell tokens.
- **⌘⏎ Commit, push, PR** — One button from finished diff to open pull request.
- **MIT open source** — Read it, patch it, fork it.

`t3x` branch rail (fork additions — each verified merged on `origin/main`, per the Global Constraints check):

- **Auto-updates** — New builds announce themselves with a changelog toast and install while you're idle.
- **Needs-input notifications** — When an agent stalls on a question, your desktop and your phone find out — not the tab you forgot.
- **Web Push + keepalive** — Notifications reach the browser on your phone, and sessions stop dozing off in the background.
- **Auto-resume** — Interrupted runs pick themselves back up, with a countdown you can cancel.
- **Daily upstream sync** — An automated agent rebases this fork onto upstream every day and keeps a public ledger of every divergence.
- **Dependency security sweep** — Pinned overrides that took open Dependabot alerts from 107 to 6, and survive every sync.

### Copy rules

- Hero headline names **T3X**; the sub-line states in its first sentence that this is a community fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT).
- The kept `#open` section is upstream's own "If you don't like something, fork it." **Keep that headline verbatim and answer it** — replace the section's body copy with, in this spirit: `So we did. T3X is that fork: same product, same license, plus the things we wanted sooner. Every line we change on top of upstream is public — additions only, re-checked against upstream every day.` Link the word "public" to `https://github.com/radroid/t3code/blob/main/docs/coil/SEAMS.md`.
- Voice: plain verbs, sentence case, specific over clever, no invented stats, no superlatives ("blazing", "supercharged" are banned). Never claim user counts, star counts, or testimonials.
- Downloads honesty (unchanged from Global Constraints): macOS Apple Silicon + Windows x64 only, unsigned builds, no store apps — stated plainly near every download control.

## Human-in-the-loop prerequisites (check before starting Tasks 5–6)

Two things only the user can provide; everything through Task 4 proceeds without them:

1. **Cloudflare auth for the first manual deploy (Task 5).** Run `pnpm dlx wrangler@4 whoami` from `apps/t3x-home`. If not authenticated, either the user runs `pnpm dlx wrangler@4 login` (interactive browser OAuth — same account that hosts `t3x-update-relay`, workers.dev subdomain `businesses`), or exports `CLOUDFLARE_API_TOKEN`. If neither is possible, pause Task 5/6 and report; Tasks 1–4 and 7 are still completable.
2. **CI secrets (Task 6).** A Cloudflare API token with **Account → Workers Scripts → Edit** permission, stored via `gh secret set CLOUDFLARE_API_TOKEN -R radroid/t3code`, plus `gh variable set CLOUDFLARE_ACCOUNT_ID -R radroid/t3code --body <account-id>` (account ID is printed by `wrangler whoami`). Neither exists today — verified: repo secrets are only `CLAUDE_CODE_OAUTH_TOKEN` and `T3X_UPDATE_HMAC_SECRET`.

---

### Task 1: Scaffold `apps/t3x-home` as a building copy

**Files:**

- Create: `apps/t3x-home/**` (copied from `apps/marketing/**`)
- Do not copy: `apps/marketing/vercel.ts`, `apps/marketing/.astro/`, `apps/marketing/.DS_Store`

**Interfaces:**

- Produces: workspace package `@t3tools/t3x-home` with scripts `dev`, `build`, `preview`, `typecheck` — later tasks build with `vp run --filter @t3tools/t3x-home build` and expect output in `apps/t3x-home/dist/`.

- [ ] **Step 1: Branch off fresh main**

```bash
cd /Users/rajdholakia/Developer/t3code
git fetch origin
git checkout -b t3x/homepage origin/main
```

- [ ] **Step 2: Copy the app, excluding Vercel and cache files**

```bash
rsync -a --exclude '.astro' --exclude '.DS_Store' --exclude 'vercel.ts' \
  apps/marketing/ apps/t3x-home/
```

- [ ] **Step 3: Rewrite `apps/t3x-home/package.json`**

Replace the whole file with:

```json
{
  "name": "@t3tools/t3x-home",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "typecheck": "astro check",
    "//deploy": "wrangler is run via `pnpm dlx`, not depended on — it drags ~500 lines into pnpm-lock.yaml, the fork's second-worst rebase-conflict surface, and is only needed at deploy time.",
    "deploy": "pnpm dlx wrangler@4 deploy"
  },
  "dependencies": {
    "@t3tools/shared": "workspace:*",
    "astro": "^7.0.3"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.7",
    "typescript": "catalog:"
  }
}
```

(Keeps `@t3tools/shared` for now — the copied `src/pages/schema/t3.json.ts` imports it; both are removed in Task 2. Drops `@vercel/config`.)

- [ ] **Step 4: Register the package and verify it builds**

```bash
pnpm install
vp run --filter @t3tools/t3x-home typecheck
vp run --filter @t3tools/t3x-home build
ls apps/t3x-home/dist/index.html
```

Expected: typecheck and build succeed; `dist/index.html` exists. `pnpm install` will touch `pnpm-lock.yaml` (adding the new workspace package) — that is expected; verify with `git diff pnpm-workspace.yaml` that the `overrides:` block is untouched (the file should have no diff at all).

- [ ] **Step 5: Commit**

```bash
git add apps/t3x-home pnpm-lock.yaml
git commit -m "feat(t3x): seed the fork homepage from apps/marketing"
```

---

### Task 2: Strip upstream-only content (testimonials, stats, store links, legal, schema)

**Files:**

- Modify: `apps/t3x-home/src/pages/index.astro`
- Modify: `apps/t3x-home/src/layouts/Layout.astro`
- Modify: `apps/t3x-home/src/lib/site.ts`
- Delete: `apps/t3x-home/src/lib/tweets.ts`, `apps/t3x-home/tweets.md`, `apps/t3x-home/public/pfps/`, `apps/t3x-home/src/pages/schema/`, `apps/t3x-home/src/pages/privacy-policy.astro`, `apps/t3x-home/src/pages/terms-of-service.astro`, `apps/t3x-home/src/pages/security-policy.astro`, `apps/t3x-home/src/pages/legal.astro`, `apps/t3x-home/src/components/LegalPage.astro`

**Interfaces:**

- Produces: `src/lib/site.ts` exporting exactly `GITHUB_REPOSITORY_URL` (fork URL) and `UPSTREAM_REPOSITORY_URL` — Task 3 copy and Task 4 pages import these names.

- [ ] **Step 1: Delete the upstream-only files**

```bash
cd apps/t3x-home
git rm -r src/lib/tweets.ts tweets.md public/pfps src/pages/schema \
  src/pages/privacy-policy.astro src/pages/terms-of-service.astro \
  src/pages/security-policy.astro src/pages/legal.astro src/components/LegalPage.astro
```

- [ ] **Step 2: Replace `src/lib/site.ts`**

```ts
export const GITHUB_REPOSITORY_URL = "https://github.com/radroid/t3code";

export const UPSTREAM_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";
```

(Removes `IOS_APP_STORE_URL`, `ANDROID_PLAY_STORE_URL`, and `MARKETING_STATS` — the store listings and user/star counts are upstream's, not the fork's.)

- [ ] **Step 3: Purge index.astro of the removed exports**

In `src/pages/index.astro`: remove the imports of `tweets`, `IOS_APP_STORE_URL`, `ANDROID_PLAY_STORE_URL`, `MARKETING_STATS`; remove the entire endorsements section (the block containing `id="endorsements-title"` — "Tolerated by over … devs" — and every element rendering `tweet` / `pfps/`); remove the iOS/Android store-link elements around lines 76–78; replace the `MARKETING_STATS.githubStars` stars badge (~line 349) with a plain "Open source" link using `GITHUB_REPOSITORY_URL`. Leave all other sections (hero, feature demos, terminal mock, download CTA) intact — Task 3 rebrands their copy.

- [ ] **Step 4: Fix Layout.astro nav/footer links**

In `src/layouts/Layout.astro`, remove or repoint any `href` to the deleted pages (`/legal`, `/privacy-policy`, `/terms-of-service`, `/security-policy`). Where a legal footer link existed, substitute a single link: `For the original product and its policies, see <a href={UPSTREAM_REPOSITORY_URL}>T3 Code</a>.` (import `UPSTREAM_REPOSITORY_URL` from `../lib/site`).

- [ ] **Step 5: Drop the now-unused `@t3tools/shared` dependency**

Remove `"@t3tools/shared": "workspace:*"` from `apps/t3x-home/package.json` dependencies, then:

```bash
cd /Users/rajdholakia/Developer/t3code && pnpm install
```

- [ ] **Step 6: Verify no dangling references, then build**

```bash
grep -rn "tweets\|pfps\|MARKETING_STATS\|APP_STORE\|PLAY_STORE\|LegalPage\|privacy-policy\|terms-of-service\|security-policy\|t3tools/shared" apps/t3x-home/src
vp run --filter @t3tools/t3x-home typecheck
vp run --filter @t3tools/t3x-home build
```

Expected: grep returns nothing; typecheck and build pass.

- [ ] **Step 7: Commit**

```bash
git add -A apps/t3x-home pnpm-lock.yaml
git commit -m "feat(t3x): strip upstream-only social proof, store links, and legal pages"
```

---

### Task 3: Rebrand copy and metadata as the T3X fork

**Files:**

- Modify: `apps/t3x-home/src/layouts/Layout.astro`
- Modify: `apps/t3x-home/src/pages/index.astro`
- Modify: `apps/t3x-home/astro.config.mjs`

**Interfaces:**

- Consumes: `GITHUB_REPOSITORY_URL`, `UPSTREAM_REPOSITORY_URL` from Task 2's `site.ts`.

- [ ] **Step 1: Set site URL in `astro.config.mjs`**

```js
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://t3x-home.businesses.workers.dev",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
```

- [ ] **Step 2: Rebrand Layout.astro metadata**

In `src/layouts/Layout.astro` change the prop defaults (lines ~16–17):

```ts
title = "T3X — a T3 Code fork",
description = "T3X — a community fork of T3 Code with auto-updates, push notifications, and a daily upstream sync.",
```

Update any OG/twitter meta tags in the same file to use these values and the site URL above.

- [ ] **Step 3: Flip the accent and rebrand the chrome in Layout.astro**

Per **Design & content spec → Design stance**:

- Change `--accent-h: 250;` to `--accent-h: 150;` (one line — the derived `--accent`/`--accent-dim` follow). Change nothing else in the token block.
- `nav-brand-name`: `T3 Code` → `T3X`; update the brand `aria-label` to "T3X home".
- Replace the `nav-stars` pill (star icon + `{MARKETING_STATS.githubStars}` count) with a plain `GitHub` link to `GITHUB_REPOSITORY_URL`, keeping the pill's CSS class so styling holds.
- Footer brand line: `&copy; {new Date().getFullYear()} T3X contributors · MIT · a fork of <a href={UPSTREAM_REPOSITORY_URL}>T3 Code</a> by T3 Tools Inc`.
- Footer links reduce to: GitHub (fork), Download (`/download`), Upstream (`UPSTREAM_REPOSITORY_URL`). Discord and store links go (Task 2 already removed their URL constants).

- [ ] **Step 4: Recopy the hero in index.astro**

Per **Design & content spec → Copy rules**: headline names **T3X**; sub-line's first sentence states it is a community fork of T3 Code (MIT), linking `T3 Code` to `UPSTREAM_REPOSITORY_URL`; `hero-source-link` keeps pointing at `GITHUB_REPOSITORY_URL` (now the fork). Keep `screenshot.webp` and update its `alt` to mention T3X. Near the download buttons add the platform-honesty line ("Unsigned builds for macOS (Apple Silicon) and Windows (x64). No store apps.") and the static sync strip that Task 4 wires live:

```html
<p class="hero-sync" data-sync-strip>Rebased onto upstream daily</p>
```

Style `.hero-sync` with `font-family: var(--font-mono)`, `font-size: 0.8rem`, `color: var(--fg-dim)`.

- [ ] **Step 5: Build the fork graph section**

In the slot where the endorsements section was deleted (between the hero and `#harnesses`), add `<section id="fork-graph" class="sec-fork-graph">` implementing **Design & content spec → The fork graph** exactly: `<h2>Everything T3 Code is. Plus a branch.</h2>`, then two `<ol>` lists — `main` rail with the 4 core-product cards (hollow dots, `--fg-muted` rail) and `t3x` branch rail with the 6 fork cards (filled dots and rail in `var(--accent)`), copy verbatim from the spec, divergence caption `rebased onto upstream daily`. CSS-drawn rails and dots only (borders + `::before`), stacked layout under 720px, one optional scroll reveal guarded by `prefers-reduced-motion`. Before committing, spot-check each of the 6 fork cards against reality: `git log origin/main --oneline | grep -i <keyword>`.

- [ ] **Step 6: Answer the "fork it" section**

In the kept `#open` section: keep the `If you don't like something, fork it.` headline verbatim; replace the body copy with the "So we did." paragraph from **Design & content spec → Copy rules**, linking "public" to `https://github.com/radroid/t3code/blob/main/docs/coil/SEAMS.md`. Keep the section's terminal-mock styling; its `GITHUB_REPOSITORY_URL` link now points at the fork, which is correct.

- [ ] **Step 7: Verify branding landed, then build**

```bash
grep -c "T3X" apps/t3x-home/src/pages/index.astro        # expected: >= 3
grep -n -- "--accent-h: 150" apps/t3x-home/src/layouts/Layout.astro   # expected: 1 match
grep -c "fork-graph" apps/t3x-home/src/pages/index.astro # expected: >= 1
grep -rn "Tolerated by\|nav-stars.*MARKETING" apps/t3x-home/src && echo "FAIL: upstream copy survives"
vp run --filter @t3tools/t3x-home build
```

Expected: T3X count ≥ 3, accent hue flipped, fork-graph present, no upstream-copy match, build passes.

- [ ] **Step 8: Visual smoke check**

```bash
vp run --filter @t3tools/t3x-home preview &   # serves dist on port 4173
sleep 3 && curl -s http://localhost:4173/ | grep -o "<title>[^<]*</title>"
kill %1
```

Expected: `<title>T3X — a T3 Code fork</title>`.

- [ ] **Step 9: Commit**

```bash
git add apps/t3x-home
git commit -m "feat(t3x): rebrand the homepage copy, chrome, and fork graph"
```

---

### Task 4: Point downloads at the fork's release pipeline

**Why this must change:** every fork release is a **pre-release**, so upstream's lookup (`api.github.com/repos/<repo>/releases/latest`) returns 404 for `radroid/t3code` (verified 2026-08-10). The fork already publishes a richer manifest through the update relay.

**Files:**

- Modify: `apps/t3x-home/src/lib/releases.ts` (full replacement below)
- Modify: `apps/t3x-home/src/pages/download.astro`
- Modify: `apps/t3x-home/src/pages/index.astro` (wire the hero sync strip from Task 3)

**Interfaces:**

- Produces: `fetchLatestManifest(): Promise<Manifest>` and `RELEASES_URL` — `download.astro` consumes these. Manifest shape verified live against `https://t3x-update-relay.businesses.workers.dev/latest`.

- [ ] **Step 1: Replace `src/lib/releases.ts`**

```ts
const MANIFEST_URL = "https://t3x-update-relay.businesses.workers.dev/latest";
const CACHE_KEY = "t3x-latest-manifest";

export const RELEASES_URL = "https://github.com/radroid/t3code/releases";

export interface ManifestAsset {
  platform: "darwin-arm64" | "win32-x64";
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  version: string;
  releaseTag: string;
  builtAt: string;
  changes: string[];
  assets: ManifestAsset[];
}

export async function fetchLatestManifest(): Promise<Manifest> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const data = await fetch(MANIFEST_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}
```

- [ ] **Step 2: Rework `download.astro` against the new interface**

Requirements for the page (currently built around GitHub's `tag_name` / `assets[].browser_download_url` / asset-name sniffing — all of that goes):

- Two download buttons from `manifest.assets`: `platform === "darwin-arm64"` → "macOS (Apple Silicon)", `platform === "win32-x64"` → "Windows (x64)"; each links to `asset.url` and shows size as `Math.round(bytes / 1e6)` MB.
- Show `manifest.version` and `builtAt` date near the buttons.
- Render `manifest.changes` (first 10 entries) as a "What's new" list.
- Remove any Linux / iOS / Android download affordances; add one line: "Linux builds aren't published yet — build from [source](https://github.com/radroid/t3code)."
- Keep the "all releases" link → `RELEASES_URL`.
- Failure path: if the fetch throws or `assets` is missing, show the `RELEASES_URL` link as the fallback CTA (the relay had a transient 500 on 2026-08-10 — degrade gracefully).

- [ ] **Step 3: Wire the hero sync strip**

Add to `index.astro` (Astro bundles `<script>` tags as modules, so the ESM import works):

```astro
<script>
  import { fetchLatestManifest } from "../lib/releases";

  const strip = document.querySelector("[data-sync-strip]");
  if (strip) {
    fetchLatestManifest()
      .then((m) => {
        const upstream = m.version.split("-t3x")[0];
        const built = new Date(m.builtAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        strip.textContent = `${m.version} · tracking upstream v${upstream} · built ${built}`;
      })
      .catch(() => {}); // static "Rebased onto upstream daily" fallback stays
  }
</script>
```

- [ ] **Step 4: Verify the manifest contract still holds**

```bash
curl -s https://t3x-update-relay.businesses.workers.dev/latest | \
  python3 -c "import json,sys; d=json.load(sys.stdin); assert d['version'] and d['assets'][0]['url'].startswith('https://github.com/radroid/t3code/releases/download/'); print('manifest OK:', d['version'])"
```

Expected: `manifest OK: 0.0.33-t3x.20` (or newer).

- [ ] **Step 5: Typecheck, build, smoke-test the page**

```bash
vp run --filter @t3tools/t3x-home typecheck
vp run --filter @t3tools/t3x-home build
vp run --filter @t3tools/t3x-home preview &
sleep 3 && curl -s http://localhost:4173/download/ | grep -io "windows\|macos\|apple silicon" | sort -u
kill %1
```

Expected: both platform labels present in the served HTML.

- [ ] **Step 6: Commit**

```bash
git add apps/t3x-home
git commit -m "feat(t3x): serve downloads from the fork's update-relay manifest and wire the sync strip"
```

---

### Task 5: Cloudflare Worker config, 404 page, and first manual deploy

**Files:**

- Create: `apps/t3x-home/wrangler.jsonc`
- Create: `apps/t3x-home/src/pages/404.astro`
- (No `.gitignore` needed — the root `.gitignore` already covers `apps/*/dist` and `.astro`.)

**Interfaces:**

- Produces: deployed site at `https://t3x-home.businesses.workers.dev`; `pnpm run deploy` from `apps/t3x-home` is the deploy command Task 6's CI reuses.

- [ ] **Step 1: Write `apps/t3x-home/wrangler.jsonc`**

```jsonc
{
  "$schema": "https://unpkg.com/wrangler@4/config-schema.json",
  "name": "t3x-home",
  "compatibility_date": "2026-08-10",
  // Assets-only Worker: no `main` script — Cloudflare serves ./dist directly.
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page",
  },
}
```

(Note the schema URL: unlike `infra/coil-update-relay`, wrangler is not in `node_modules` here, so the local `node_modules/wrangler/config-schema.json` path would dangle.)

- [ ] **Step 2: Add a 404 page so `not_found_handling` has a target**

`src/pages/404.astro`:

```astro
---
import Layout from "../layouts/Layout.astro";
---

<Layout title="Not found — T3X">
  <main style="min-height:60vh;display:grid;place-content:center;text-align:center;gap:1rem;">
    <h1>404</h1>
    <p>That page doesn't exist. <a href="/">Back to T3X</a>.</p>
  </main>
</Layout>
```

Rebuild and confirm Astro emits it: `vp run --filter @t3tools/t3x-home build && ls apps/t3x-home/dist/404.html`.

- [ ] **Step 3: Check Cloudflare auth (human-in-the-loop gate)**

```bash
cd apps/t3x-home && pnpm dlx wrangler@4 whoami
```

If this fails with "not authenticated", stop and ask the user to run `pnpm dlx wrangler@4 login` (or export `CLOUDFLARE_API_TOKEN`). Target account: the one hosting `t3x-update-relay` (workers.dev subdomain `businesses`).

- [ ] **Step 4: Deploy and verify**

```bash
cd apps/t3x-home && pnpm run deploy
curl -s -o /dev/null -w "%{http_code}\n" https://t3x-home.businesses.workers.dev/          # expect 200
curl -s https://t3x-home.businesses.workers.dev/ | grep -o "<title>[^<]*</title>"          # expect T3X title
curl -s -o /dev/null -w "%{http_code}\n" https://t3x-home.businesses.workers.dev/download/ # expect 200
curl -s -o /dev/null -w "%{http_code}\n" https://t3x-home.businesses.workers.dev/nope      # expect 404
```

If sandboxing blocks the deploy's network calls, rerun with escalated permissions.

- [ ] **Step 5: Commit**

```bash
git add apps/t3x-home
git commit -m "feat(t3x): deploy the homepage as a Cloudflare assets-only Worker"
```

---

### Task 6: CI auto-deploy on push to main

**Files:**

- Create: `.github/workflows/t3x-deploy-home.yml`

**Interfaces:**

- Consumes: `pnpm run deploy` from Task 5; repo secret `CLOUDFLARE_API_TOKEN` and repo variable `CLOUDFLARE_ACCOUNT_ID` (created in Step 1).

- [ ] **Step 1: Create the CI credentials (human-in-the-loop gate)**

Ask the user for a Cloudflare API token (dash.cloudflare.com → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, or custom with **Account → Workers Scripts → Edit**), then:

```bash
gh secret set CLOUDFLARE_API_TOKEN -R radroid/t3code            # paste token when prompted
ACCOUNT_ID=$(cd apps/t3x-home && pnpm dlx wrangler@4 whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
gh variable set CLOUDFLARE_ACCOUNT_ID -R radroid/t3code --body "$ACCOUNT_ID"
```

If the user can't provide the token now, still land Steps 2–4 (the workflow simply fails until the secret exists; manual `pnpm run deploy` keeps working) and note it in the final report.

- [ ] **Step 2: Write `.github/workflows/t3x-deploy-home.yml`**

```yaml
name: "t3x: deploy homepage"

on:
  push:
    branches:
      - main
    paths:
      - "apps/t3x-home/**"
      - ".github/workflows/t3x-deploy-home.yml"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: t3x-home-deploy
  cancel-in-progress: false

jobs:
  deploy:
    name: Build and deploy t3x-home
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          sparse-checkout: |
            /*
            !/.repos/
          sparse-checkout-cone-mode: false

      - name: Setup Vite+
        uses: voidzero-dev/setup-vp@v1
        with:
          node-version-file: package.json
          cache: true
          run-install: |
            args:
              - --filter=@t3tools/t3x-home...

      - name: Build
        run: vp run --filter @t3tools/t3x-home build

      - name: Deploy to Cloudflare
        working-directory: apps/t3x-home
        run: pnpm dlx wrangler@4 deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}

      - name: Verify live site
        run: |
          code=$(curl -s -o /dev/null -w "%{http_code}" https://t3x-home.businesses.workers.dev/)
          test "$code" = "200" || { echo "site returned $code"; exit 1; }
```

Known behaviors to leave alone: the daily sync force-pushes `main`, and on an undiffable force push GitHub runs `paths`-filtered workflows anyway — that's fine, `wrangler deploy` is idempotent. The workflow becomes active only after it lands on `main` (new-workflow registration behavior).

- [ ] **Step 3: Lint the workflow locally**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/t3x-deploy-home.yml')); print('yaml OK')"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/t3x-deploy-home.yml
git commit -m "ci(t3x): auto-deploy the homepage to Cloudflare on push to main"
```

---

### Task 7: Ledger note, runbook note, and PR

**Files:**

- Modify: `docs/coil/SEAMS.md` (append a note — adds no upstream-file rows)
- Modify: `docs/coil/sync-agent-runbook.md` (parallel-paths check item)

**Interfaces:**

- Consumes: nothing from earlier tasks besides their existence; this is bookkeeping the sync agent reads.

- [ ] **Step 1: Append the parallel-path note to `docs/coil/SEAMS.md`**

Follow the precedent of the "Update delivery adds no NEW rows" note. Append (adjust surrounding formatting to match the file):

```markdown
> **The fork homepage adds no NEW rows.** `apps/t3x-home/` is a fork-owned copy of
> `apps/marketing/` deployed to Cloudflare (`t3x-home` Worker), plus
> `.github/workflows/t3x-deploy-home.yml` — all files upstream has never seen.
> `apps/marketing/` itself remains untouched. **Parallel-path hazard:** upstream keeps
> evolving `apps/marketing/`; the copy will not conflict but will silently drift. At each
> sync, skim `git log <merge-base>..upstream/main -- apps/marketing` and port anything
> worth having (pricing changes, new pages, security-relevant fixes) by hand.
```

- [ ] **Step 2: Add the sync-runbook check item**

In `docs/coil/sync-agent-runbook.md`, find the checklist that re-checks the SEAMS table each sync and add one item, matching the list's formatting:

```markdown
- Parallel path: `apps/t3x-home/` duplicates `apps/marketing/`. Check upstream's marketing
  churn this cycle (`git log <merge-base>..upstream/main --oneline -- apps/marketing`) and
  port intentionally or record "nothing worth porting".
```

- [ ] **Step 3: Commit and open the PR**

```bash
git add docs/coil/SEAMS.md docs/coil/sync-agent-runbook.md
git commit -m "docs(t3x): record the fork homepage on the seam ledger and sync runbook"
git push -u origin t3x/homepage
gh pr create -R radroid/t3code --base main --title "feat(t3x): fork homepage on Cloudflare Workers" \
  --body "Fork-owned copy of apps/marketing rebranded for T3X, downloads wired to the update-relay manifest, deployed as the t3x-home assets-only Worker with CI auto-deploy. apps/marketing untouched; no new seam-ledger rows. Live: https://t3x-home.businesses.workers.dev

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 4: Final verification sweep**

```bash
git diff origin/main...HEAD --stat -- apps/marketing   # MUST be empty
curl -s https://t3x-home.businesses.workers.dev/ | grep -c "T3X"   # >= 1
```

If `apps/marketing` shows any diff, that is a plan violation — revert those hunks before merging.

---

## Deferred (do not build now)

- **Custom domain:** the site ships on `t3x-home.businesses.workers.dev`. If the user later buys a domain, add a `routes`/`custom_domain` entry to `wrangler.jsonc` — one-line change.
- **Replacing the upstream screenshot** with a fork-specific one showing the update toast / notifications.
- **Porting upstream marketing changes** — handled per-sync via the Task 7 runbook item, not here.
