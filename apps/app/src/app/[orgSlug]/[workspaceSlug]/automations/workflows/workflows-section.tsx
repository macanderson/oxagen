/**
 * workflows-section.tsx — async server component that loads every workflow
 * run in the workspace via listWorkflowRuns (agent.execution.list filtered to
 * originType === "workflow_run", enriched with goal/progress for the newest
 * rows — see lib/automations/workflows.ts) and renders the client table.
 * Sits inside the page's Suspense boundary so the header + tab strip paint
 * first.
 *
 * Never throws: on failure it renders the error banner inline (an RSC throw
 * would bubble to the route error boundary and blank the whole section).
 */
import { AlertCircle } from "lucide-react";
import { logger } from "@oxagen/handlers/logger";
import type { AutomationsCtx } from "@/lib/automations/scope";
import {
  listWorkflowRuns,
  type WorkflowRunRow,
} from "@/lib/automations/workflows";
import { WorkflowsTable } from "./_components/workflows-table";

export interface WorkflowsSectionProps {
  ctx: AutomationsCtx;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export async function WorkflowsSection({
  ctx,
  orgSlug,
  workspaceSlug,
  canManage,
}: WorkflowsSectionProps) {
  let workflows: WorkflowRunRow[] = [];
  let failed = false;
  try {
    workflows = await listWorkflowRuns(ctx);
  } catch (err) {
    failed = true;
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workflows: agent.execution.list failed",
    );
  }

  if (failed) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border border-error/25 bg-error/10 p-3 text-sm text-error"
        role="alert"
      >
        <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
        Couldn’t load workflows. Reload the page to try again.
      </div>
    );
  }

  return (
    <WorkflowsTable
      workflows={workflows}
      canManage={canManage}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
