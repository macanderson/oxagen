/**
 * page.tsx — Workspace → Automations → Workflows (replaces the web-app-2.0
 * Phase 0 shell).
 *
 * The launch and monitoring surface for the workflow.* (goal → N parallel
 * sub-tasks via Inngest) and research.swarm.* (topic → N parallel web
 * searches) capability families. Neither family had any UI before this page —
 * both were agent/api/mcp-only, reachable only via the chat-rendered
 * `workflow-progress` component. Server component: resolves auth +
 * org/workspace scope + workspace role, renders the shared Automations header
 * + tab strip immediately, then streams the live workflow list into
 * <WorkflowsSection> inside a Suspense boundary.
 */
import { Suspense } from "react";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import { TableSkeleton } from "@/components/loading";
import { AutomationsHeader } from "@/app/[orgSlug]/[workspaceSlug]/automations/_components/automations-header";
import { LaunchWorkflowButton } from "./_components/launch-workflow-button";
import { WorkflowsSection } from "./workflows-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkflowsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  const routeCtx = { orgSlug, workspaceSlug };

  return (
    <div className="flex flex-col gap-5">
      <AutomationsHeader
        ctx={routeCtx}
        title="Automations"
        description="Parallel workflow and research-swarm runs — launch a goal or topic, watch live sub-task progress, and cancel a run that's misbehaving."
        actions={
          canManage ? (
            <LaunchWorkflowButton orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
          ) : undefined
        }
      />
      <Suspense fallback={<TableSkeleton rows={6} cols={6} />}>
        <WorkflowsSection
          ctx={ctx}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          canManage={canManage}
        />
      </Suspense>
    </div>
  );
}
