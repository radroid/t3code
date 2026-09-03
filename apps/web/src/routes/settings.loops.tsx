import { createFileRoute } from "@tanstack/react-router";

import { LoopsSettingsPanel } from "../components/coil/LoopsSettings";

function SettingsLoopsRoute() {
  return <LoopsSettingsPanel />;
}

export const Route = createFileRoute("/settings/loops")({
  component: SettingsLoopsRoute,
});
