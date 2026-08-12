/**
 * Geometry for pinning the auto-resume capsule to the composer.
 *
 * The capsule is mounted as a sibling of `<ChatView>` inside `SidebarInset`, so its containing
 * block is `<main>`. The composer it must sit above lives several levels deeper, inside the chat
 * column — a box that upstream resizes independently: the inline right panel is a flex sibling
 * that narrows it, and the terminal drawer is an in-flow block that lifts its bottom edge.
 *
 * Measuring the composer against *its own* parent and then applying the result in `<main>`'s
 * coordinates is therefore only correct while both boxes coincide, i.e. while no panel is open.
 * Everything here converts a composer measurement into the capsule's own coordinate space instead,
 * which is what keeps the two locked together in every panel configuration.
 */

/**
 * Distance to hold above the docked composer, used until the composer has been measured and if it
 * can never be found. Roughly a one-line composer plus its bottom padding.
 */
export const COMPOSER_FALLBACK_OFFSET_PX = 76;
export const COMPOSER_GAP_PX = 8;
/**
 * Tolerance for "the overlay fills its container", i.e. the draft-hero state where the composer
 * centres itself with `inset-0` instead of docking to the bottom. Detecting that case exactly means
 * the docked case needs **no** bound on the measurement, which matters: composer banners
 * (`ComposerBannerStack`, `ThreadSyncStatusPill`, `ThreadOutboxQueueList`) render *in flow inside*
 * the measured overlay, so it legitimately grows as they appear and the capsule must keep rising
 * with it.
 *
 * Two earlier attempts bounded the measurement instead and both cut in during normal use: a 240px
 * absolute cap (the docked composer already measures ~204px, so one banner exceeded it) and a
 * fraction-of-container cap (still bound by a 90px banner on a 600px-tall window). A bound cannot
 * distinguish "tall because of banners" from "tall because of hero"; the height ratio can.
 */
export const COMPOSER_FULL_HEIGHT_TOLERANCE_PX = 4;

/** The subset of `DOMRect` this module needs, so the maths stays testable without a layout engine. */
export interface AnchorRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface ComposerAnchorInput {
  /** The composer overlay, i.e. the element the capsule must sit above. */
  readonly composer: AnchorRect | null;
  /** The composer's offsetParent — the chat column, which panels resize. */
  readonly composerParent: AnchorRect | null;
  /** The capsule's own offsetParent — `SidebarInset`, which panels do **not** resize. */
  readonly anchorParent: AnchorRect | null;
}

export interface ComposerAnchor {
  readonly visible: boolean;
  /** Offset from the anchor parent's bottom edge. */
  readonly bottom: number;
  /** Offset from the anchor parent's left edge; `null` leaves the stylesheet's `inset-x-0` alone. */
  readonly left: number | null;
  readonly width: number | null;
}

/** Pre-measurement placement: span the anchor and hold the fallback gap, as the capsule always has. */
const UNMEASURED: ComposerAnchor = {
  visible: true,
  bottom: COMPOSER_FALLBACK_OFFSET_PX,
  left: null,
  width: null,
};

/**
 * Places the capsule directly above the composer, in the capsule's own coordinate space.
 *
 * Mirrors the composer overlay's box rather than re-deriving it from the same utility classes: the
 * capsule's inner `chat-composer-horizontal-inset` + `mx-auto max-w-3xl` then reproduces the
 * composer card's box exactly, because it is running against the same width the composer had.
 */
export function resolveComposerAnchor({
  composer,
  composerParent,
  anchorParent,
}: ComposerAnchorInput): ComposerAnchor {
  if (composer === null || composerParent === null || anchorParent === null) {
    return UNMEASURED;
  }

  // A maximized right panel collapses the chat column to `w-0 flex-none`. There is no composer to
  // sit above, and a capsule left at the last good offset would float over the panel instead.
  if (composer.width <= 0 || composer.height <= 0) {
    return { ...UNMEASURED, visible: false };
  }

  const left = composer.left - anchorParent.left;

  // Draft-hero: the overlay spans the whole thread area, so its top edge is the top of the thread
  // and is meaningless as an anchor. Hold the fallback above the *column's* bottom rather than the
  // anchor's, so the drawer still pushes the capsule clear of itself in this state.
  if (composer.height >= composerParent.height - COMPOSER_FULL_HEIGHT_TOLERANCE_PX) {
    return {
      visible: true,
      bottom: anchorParent.bottom - composerParent.bottom + COMPOSER_FALLBACK_OFFSET_PX,
      left: composerParent.left - anchorParent.left,
      width: composerParent.width,
    };
  }

  // Everywhere else, track the composer's top edge exactly — banners included.
  return {
    visible: true,
    bottom: anchorParent.bottom - composer.top + COMPOSER_GAP_PX,
    left,
    width: composer.width,
  };
}
