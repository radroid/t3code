/**
 * The fork's per-thread overlay surface, in one place.
 *
 * This exists so `routes/_chat.$environmentId.$threadId.tsx` — an upstream file with a seam row —
 * names exactly one fork component forever. The row swapped one JSX element for one JSX element
 * and one import for one import, so its `+10/−6` is unchanged and the seam delta of adding the
 * loop console is **zero**. Every future per-thread fork surface now costs nothing at all: it is
 * added here, not there.
 *
 * Both children position themselves against the docked composer through the shared
 * `useComposerAnchor`, and each owns its own absolutely-positioned wrapper. That is deliberate
 * rather than a shared wrapper: `resolveComposerAnchor` reads `anchorElement.offsetParent`, so
 * introducing a positioned box between the overlays and `SidebarInset` would silently change the
 * third rect the whole measurement is resolved against. They share the measurement, not the box —
 * the auto-resume capsule holds the right of the composer card, the loop console the left.
 *
 * @module coil/ThreadCoilOverlay
 */

import { AutoResumeOverlay, type AutoResumeThreadRef } from "./AutoResumeOverlay";
import { LoopConsole } from "./loop/LoopConsole";

export interface ThreadCoilOverlayProps {
  readonly threadRef: AutoResumeThreadRef;
}

export function ThreadCoilOverlay({ threadRef }: ThreadCoilOverlayProps) {
  return (
    <>
      <AutoResumeOverlay threadRef={threadRef} />
      <LoopConsole threadRef={threadRef} />
    </>
  );
}
