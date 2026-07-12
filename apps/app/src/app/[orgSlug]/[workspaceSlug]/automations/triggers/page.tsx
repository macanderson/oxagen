/**
 * page.tsx — Workspace → Automations → Triggers board.
 *
 * A workspace-wide audit board of every agent.trigger.* binding — the manual/
 * cron/event activations configured on individual agents. Server component —
 * resolves auth + org/workspace scope + workspace role (for `canManage` and
 * the Create button's agent picker), renders the shared Automations header +
 * tab strip immediately, then streams the per-agent trigger fan-out inside
 * <TriggersSection> inside a Suspense boundary.
 *
 * Replaces the web-app-2.0 Phase 0 EmptyState shell.
 */
import { Suspense } from "react";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import { listAgentOptions, type AgentOption } from "@/lib/automations/triggers";
import { TableSkeleton } from "@/components/loading";
import { AutomationsHeader } from "@/app/[orgSlug]/[workspaceSlug]/automations/_components/automations-header";
import { CreateTriggerButton } from "./_components/create-trigger-button";
import { TriggersSection } from "./triggers-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function TriggersPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  const routeCtx = { orgSlug, workspaceSlug };

  // Cheap (single agent.definition.list call) — unlike the streamed per-agent
  // list_triggers fan-out below, this can resolve before the header paints
  // without meaningfully delaying it. Never blanks the page on failure: the
  // Create button just renders with an empty picker, and its dialog explains.
  let agentOptions: AgentOption[] = [];
  if (canManage) {
    try {
      agentOptions = await listAgentOptions(ctx);
    } catch (err) {
      console.error("triggers: listAgentOptions failed:", err);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <AutomationsHeader
        ctx={routeCtx}
        title="Automations"
        description="The workspace-wide board of every manual, schedule, and event trigger configured across your agents — see what can fire unattended before it surprises you."
        actions={
          canManage ? (
            <CreateTriggerButton
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              agents={agentOptions}
            />
          ) : undefined
        }
      />
      <Suspense fallback={<TableSkeleton rows={6} cols={5} />}>
        <TriggersSection orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      </Suspense>
    </div>
  );
}
