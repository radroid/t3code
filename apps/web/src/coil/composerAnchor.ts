/**
 * The shared "sit directly above the docked composer" hook.
 *
 * Extracted from `AutoResumeOverlay.tsx` unchanged when the loop console became a second
 * per-thread fork surface with the same placement problem. Two independent copies of this
 * measurement would be the fork's own known failure mode — a parallel path that drifts from the
 * one that was actually debugged — so both overlays now read the same numbers from here.
 *
 * The maths itself lives in `autoResumeAnchor.ts`; this module is only the DOM half: find the
 * composer, observe the three boxes that can move it, and hand `resolveComposerAnchor` three
 * rects.
 *
 * @module coil/composerAnchor
 */

import { useEffect, useState } from "react";

import {
  type AnchorRect,
  COMPOSER_FALLBACK_OFFSET_PX,
  type ComposerAnchor,
  resolveComposerAnchor,
} from "./autoResumeAnchor";

/**
 * Read-only DOM dependency on upstream's composer overlay — the same element `ChatView` measures
 * for its own `composerOverlayHeight`. The overlays are mounted as siblings of `<ChatView>` in the
 * route file, so they cannot receive that geometry as a prop without widening the seam. Degrades to
 * `COMPOSER_FALLBACK_OFFSET_PX` if the attribute ever disappears. Recorded in docs/coil/SEAMS.md.
 */
export const COMPOSER_OVERLAY_SELECTOR = '[data-chat-composer-overlay="true"]';

export const UNMEASURED_ANCHOR: ComposerAnchor = {
  visible: true,
  bottom: COMPOSER_FALLBACK_OFFSET_PX,
  left: null,
  width: null,
};

function toAnchorRect(element: Element | null): AnchorRect | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  const { top, bottom, left, width, height } = element.getBoundingClientRect();
  return { top, bottom, left, width, height };
}

function sameAnchor(a: ComposerAnchor, b: ComposerAnchor): boolean {
  return (
    a.visible === b.visible && a.bottom === b.bottom && a.left === b.left && a.width === b.width
  );
}

/**
 * Mirrors the composer overlay's box onto an overlay, in that overlay's own coordinate space.
 *
 * `anchorElement` is the overlay's positioned wrapper: it is what supplies the third rect the maths
 * needs — its `offsetParent` (`SidebarInset`) is the box the returned `bottom`/`left` are resolved
 * against, and it is the one box the panels do NOT resize. Reading it here rather than assuming it
 * matches the composer's parent is the whole fix; see `resolveComposerAnchor`.
 *
 * Observes all three boxes because each panel perturbs a different one: the right panel changes the
 * chat column's width, the terminal drawer changes its height, and collapsing the main sidebar
 * changes `SidebarInset`'s width. A `ResizeObserver` fires per frame during those transitions and
 * during a drag-resize, so the overlay travels with the composer rather than snapping after it.
 */
export function useComposerAnchor(anchorElement: HTMLElement | null): ComposerAnchor {
  const [anchor, setAnchor] = useState<ComposerAnchor>(UNMEASURED_ANCHOR);

  useEffect(() => {
    if (anchorElement === null) {
      return;
    }
    const composer = document.querySelector(COMPOSER_OVERLAY_SELECTOR);
    if (!(composer instanceof HTMLElement)) {
      setAnchor(UNMEASURED_ANCHOR);
      return;
    }

    const measure = () => {
      const next = resolveComposerAnchor({
        composer: toAnchorRect(composer),
        composerParent: toAnchorRect(composer.offsetParent),
        anchorParent: toAnchorRect(anchorElement.offsetParent),
      });
      // Identity-stable when nothing moved: a drag-resize of the drawer would otherwise re-render
      // the overlay on every frame for no visible change.
      setAnchor((previous) => (sameAnchor(previous, next) ? previous : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    if (composer.offsetParent instanceof HTMLElement) {
      observer.observe(composer.offsetParent);
    }
    if (anchorElement.offsetParent instanceof HTMLElement) {
      observer.observe(anchorElement.offsetParent);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchorElement]);

  return anchor;
}
