"use client";
/**
 * workflow-detail-drawer.tsx — live sub-task progress for one workflow run or
 * research swarm, reusing the chat render components rather than
 * reimplementing polling:
 *  - Workflow: <WorkflowProgress> (apps/app/src/components/chat/registry-
 *    components/workflow-progress.tsx) polls GET /api/v1/{org}/{ws}/
 *    workflows/{id} every 3s and already renders its own Cancel action.
 *  - Swarm: <ResearchSwarmCard> polls GET /api/v1/{org}/{ws}/research/swarm/
 *    status?swarmId=... every 2s once given the tenant slugs.
 *
 * Cancel (gated): workflow.cancel is additionally exposed here, gated on
 * `canManage`, as this page's authoritative cancel action (via
 * cancelWorkflowAction → the IAM-gated Server Action). Note the reused
 * WorkflowProgress widget also renders its own Cancel button, ungated by
 * `canManage` — it calls the API route directly, which is the same behavior
 * that surface has in chat; this page's stricter Owner/Admin-only gate is an
 * additional restriction layered on top for the dedicated actions here, not a
 * capability-level change.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import WorkflowProgress from "@/components/chat/registry-components/workflow-progress";
import ResearchSwarmCard from "@/components/chat/registry-components/research-swarm-card";
import { cancelWorkflowAction } from "../actions";
import type { SwarmSessionRecord } from "./swarm-session-store";

export type WorkflowDetailTarget =
  | {
      type: "workflow";
      id: string;
      title?: string;
      goal?: string;
      status: string;
    }
  | { type: "swarm"; swarm: SwarmSessionRecord };

export interface WorkflowDetailDrawerProps {
  target: WorkflowDetailTarget | null;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

const TERMINAL_WORKFLOW_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function WorkflowDetailDrawer({
  target,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  canManage,
}: WorkflowDetailDrawerProps) {
  const router = useRouter();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    if (!target || target.type !== "workflow") return;
    setCancelling(true);
    // finally: a rejected action would otherwise leave the drawer's Cancel
    // button disabled and stuck on "Cancelling…" until the page is reloaded.
    try {
      const res = await cancelWorkflowAction({
        orgSlug,
        workspaceSlug,
        workflowId: target.id,
      });
      if (res.ok) {
        toast.add({ title: "Workflow cancelled", type: "success" });
        router.refresh();
      } else {
        toast.add({
          title: "Couldn't cancel",
          description: res.error,
          type: "error",
        });
      }
    } catch {
      toast.add({ title: "Couldn't cancel", type: "error" });
    } finally {
      setCancelling(false);
    }
  }

  // Compute title/description/cancel-eligibility via a single narrowing
  // switch rather than derived booleans — a boolean flag doesn't carry the
  // discriminated-union narrowing forward to later property accesses on
  // `target`, so each branch narrows `target` directly instead.
  let title: string | undefined;
  let description: string | undefined;
  let canCancel = false;
  if (target !== null) {
    if (target.type === "workflow") {
      title = target.title ?? "Workflow run";
      description = target.goal;
      canCancel = canManage && !TERMINAL_WORKFLOW_STATUSES.has(target.status);
    } else {
      title = "Research swarm";
      description = target.swarm.topic;
    }
  }

  return (
    <Drawer
      open={target !== null}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
    >
      <div className="flex flex-col gap-4">
        {target !== null && target.type === "workflow" && (
          <WorkflowProgress
            workflowId={target.id}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        )}
        {target !== null && target.type === "swarm" && (
          <ResearchSwarmCard
            output={{
              swarmId: target.swarm.swarmId,
              status: target.swarm.status,
              completedTasks: target.swarm.completedTasks,
              totalTasks: target.swarm.totalTasks,
            }}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        )}

        {canCancel && (
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleCancel()}
              disabled={cancelling}
              data-testid="drawer-cancel-workflow"
            >
              {cancelling ? "Cancelling…" : "Cancel workflow"}
            </Button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
