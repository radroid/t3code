import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FALLBACK_OFFSET_PX,
  COMPOSER_GAP_PX,
  type AnchorRect,
  resolveComposerAnchor,
} from "./autoResumeAnchor";

/**
 * Every rect below is a real `getBoundingClientRect()` reading taken from the running app at
 * 1440x900 with the sidebar expanded, so the expected numbers are the ones the browser actually
 * produced rather than a re-derivation of the formula under test.
 */
const rect = (top: number, bottom: number, left: number, width: number): AnchorRect => ({
  top,
  bottom,
  left,
  width,
  height: bottom - top,
});

/** `<main>` / `SidebarInset` — the capsule's own offsetParent. Never moves in these scenarios. */
const SIDEBAR_INSET = rect(0, 900, 256, 1184);

describe("resolveComposerAnchor", () => {
  it("sits one gap above the composer when no panel is open", () => {
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(696, 900, 256, 1184),
    });

    // 900 - 696 + 8. Matches the `212px` the current build produces in this state.
    expect(anchor).toEqual({ visible: true, bottom: 212, left: 0, width: 1184 });
  });

  it("narrows with the chat column when the right panel opens", () => {
    // The inline right panel is a flex sibling, so the chat column loses 540px of width. The
    // capsule currently keeps spanning all of SidebarInset and drifts 352px past the composer.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 644),
      composer: rect(696, 900, 256, 644),
    });

    expect(anchor).toEqual({ visible: true, bottom: 212, left: 0, width: 644 });
  });

  it("rises with the composer when the terminal drawer opens", () => {
    // The drawer is an in-flow 280px block at the bottom of the chat column, so the column's
    // bottom edge lifts from 900 to 620 and the composer rises with it. `SidebarInset` does not
    // move, so the capsule's bottom must grow by exactly the drawer height.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 620, 256, 1184),
      composer: rect(416, 620, 256, 1184),
    });

    // 900 - 416 + 8 = 492, i.e. 212 + the 280px drawer.
    expect(anchor).toEqual({ visible: true, bottom: 492, left: 0, width: 1184 });
  });

  it("tracks both axes when the right panel and the drawer are open together", () => {
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 620, 256, 644),
      composer: rect(416, 620, 256, 644),
    });

    expect(anchor).toEqual({ visible: true, bottom: 492, left: 0, width: 644 });
  });

  it("offsets left when the composer does not start at the anchor's left edge", () => {
    // Guards the coordinate conversion itself: `left` is composer-relative-to-anchor, not a raw
    // viewport coordinate. A raw value would push the capsule a full sidebar-width off-screen.
    const anchor = resolveComposerAnchor({
      anchorParent: rect(0, 900, 256, 1184),
      composerParent: rect(52, 900, 456, 984),
      composer: rect(696, 900, 456, 984),
    });

    expect(anchor.left).toBe(200);
    expect(anchor.width).toBe(984);
  });

  it("falls back to a fixed offset in the draft-hero state, where the composer fills the column", () => {
    // The hero composer centres itself with `inset-0`, so its top edge is the top of the thread
    // area and is meaningless as an anchor.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(52, 900, 256, 1184),
    });

    expect(anchor).toEqual({
      visible: true,
      bottom: COMPOSER_FALLBACK_OFFSET_PX,
      left: 0,
      width: 1184,
    });
  });

  it("keeps the draft-hero fallback above the drawer rather than behind it", () => {
    // The fallback is measured from the chat column's bottom, not the anchor's, so opening the
    // drawer under a hero composer still lifts the capsule clear of it.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 620, 256, 1184),
      composer: rect(52, 620, 256, 1184),
    });

    expect(anchor.bottom).toBe(280 + COMPOSER_FALLBACK_OFFSET_PX);
  });

  it("treats a composer a few pixels short of the column as the hero state", () => {
    // Sub-pixel layout means the hero composer rarely measures exactly its parent's height.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(55, 900, 256, 1184),
    });

    expect(anchor.bottom).toBe(COMPOSER_FALLBACK_OFFSET_PX);
  });

  it("still tracks a tall docked composer, which banners legitimately produce", () => {
    // A composer grown by ComposerBannerStack / ThreadSyncStatusPill is tall but nowhere near
    // filling the column, so it must keep being tracked exactly rather than snapping to the
    // fallback. This is the case a height *cap* could never distinguish from the hero.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(600, 900, 256, 1184),
    });

    expect(anchor.bottom).toBe(900 - 600 + COMPOSER_GAP_PX);
  });

  it("hides when the right panel is maximized and the chat column collapses to zero width", () => {
    // `data-chat-column-maximized-away` sets the column to `w-0 flex-none`; there is no composer
    // to sit above, so a capsule pinned at the old offset would just float over the panel.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 0),
      composer: rect(696, 900, 256, 0),
    });

    expect(anchor.visible).toBe(false);
  });

  it("hides when the composer has collapsed to zero height", () => {
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(900, 900, 256, 1184),
    });

    expect(anchor.visible).toBe(false);
  });

  it("degrades to the pre-measurement placement when the composer cannot be found", () => {
    // The seam is a read-only DOM dependency on upstream; if the attribute ever disappears the
    // capsule must still render somewhere sane rather than at bottom: 0.
    const anchor = resolveComposerAnchor({
      anchorParent: SIDEBAR_INSET,
      composerParent: null,
      composer: null,
    });

    expect(anchor).toEqual({
      visible: true,
      bottom: COMPOSER_FALLBACK_OFFSET_PX,
      left: null,
      width: null,
    });
  });

  it("degrades the same way before the anchor element has been attached", () => {
    const anchor = resolveComposerAnchor({
      anchorParent: null,
      composerParent: rect(52, 900, 256, 1184),
      composer: rect(696, 900, 256, 1184),
    });

    expect(anchor).toEqual({
      visible: true,
      bottom: COMPOSER_FALLBACK_OFFSET_PX,
      left: null,
      width: null,
    });
  });
});
