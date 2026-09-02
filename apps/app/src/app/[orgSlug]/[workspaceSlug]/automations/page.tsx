/**
 * page.tsx — Workspace → Automations (list, tab-strip default tab).
 *
 * The management surface for the automation.* family: every playbook bound to
 * an event, schedule, or manual trigger, with human-gated activation front and
 * center. Server component — resolves auth + org/workspace scope + workspace
 * role, renders the header + tab strip immediately, then streams the live
 * automation.list into <AutomationsSection> inside a Suspense boundary.
 */
import { Suspense } from "react";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import { TableSkeleton } from "@/components/loading";
import { AutomationsHeader } from "./_components/automations-header";
import { NewAutomationButton } from "./_components/new-automation-button";
import { AutomationsSection } from "./automations-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function AutomationsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  const routeCtx = { orgSlug, workspaceSlug };

  return (
    <div className="flex flex-col gap-5">
      <AutomationsHeader
        ctx={routeCtx}
        actions={
          canManage ? (
            <NewAutomationButton
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
            />
          ) : undefined
        }
      />
      <Suspense fallback={<TableSkeleton rows={6} cols={4} />}>
        <AutomationsSection
          ctx={ctx}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          canManage={canManage}
        />
      </Suspense>
    </div>
  );
}
