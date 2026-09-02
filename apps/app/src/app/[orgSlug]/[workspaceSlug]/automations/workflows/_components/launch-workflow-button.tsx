"use client";
/**
 * launch-workflow-button.tsx — the page-header primary action. Owns the
 * launch dialog's open state so the server page can slot a single client
 * entry point into AutomationsHeader's `actions` (same shape as
 * new-automation-button.tsx one level up).
 *
 * A launched swarm is recorded via useSwarmSessionStore so it isn't lost even
 * if the viewer never scrolls to the Swarms tab before navigating away; the
 * table's own store instance resyncs from sessionStorage when that tab
 * becomes active (see swarm-session-store.ts).
 */
import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LaunchWorkflowDialog } from "./launch-workflow-dialog";
import { useSwarmSessionStore } from "./swarm-session-store";

export interface LaunchWorkflowButtonProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function LaunchWorkflowButton({
  orgSlug,
  workspaceSlug,
}: LaunchWorkflowButtonProps) {
  const [open, setOpen] = useState(false);
  const { addSwarm } = useSwarmSessionStore(orgSlug, workspaceSlug);

  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="launch-workflow"
      >
        <Play className="size-4" /> Launch
      </Button>
      <LaunchWorkflowDialog
        open={open}
        onOpenChange={setOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        onSwarmLaunched={addSwarm}
      />
    </>
  );
}
