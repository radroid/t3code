import { useAtomMount } from "@effect/atom-react";

import { runningThreadKeepAliveAtom } from "../../state/threads";
// coil: fork-owned update delivery, hosted here rather than in __root.tsx because this component
// is desktop-only, lives as long as the app, and upstream rarely edits it. See docs/coil/SEAMS.md.
import { CoilUpdateToast } from "../coil/UpdateToast";

/**
 * Desktop only. Keeps each running thread subscribed in every enabled
 * environment, so opening one shows live state without a replay or a sync
 * status flash. It mounts the atom without reading it, so thread updates
 * never re-render.
 */
export function RunningThreadKeepAlive() {
  useAtomMount(runningThreadKeepAliveAtom);
  return <CoilUpdateToast />;
}
