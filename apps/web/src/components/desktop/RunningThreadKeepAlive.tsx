import { useAtomMount } from "@effect/atom-react";

import { runningThreadKeepAliveAtom } from "../../state/threads";
// coil: fork-owned update delivery, hosted here rather than in __root.tsx because this component
// is desktop-only, lives as long as the app, and upstream rarely edits it. See docs/coil/SEAMS.md.
import { CoilUpdateToast } from "../coil/UpdateToast";

export function RunningThreadKeepAlive() {
  useAtomMount(runningThreadKeepAliveAtom);
  return <CoilUpdateToast />;
}
