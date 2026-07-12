/**
 * page.tsx — Workspace → Activity → Fleet.
 *
 * Subagent fan-out observability: the fan-out list, or (via the `?fanout=<id>`
 * query param) one fan-out's detail — timeline, per-child row table, cancel.
 * Query-param detail keeps routes.ts frozen (no nested [fanoutId] route).
 *
 * Server component: resolves auth + org/workspace scope + IAM (canManage) via
 * resolveWorkbenchScope, then defers the live invoke() reads to
 * <FleetListSection> / <FleetDetailSection> inside a Suspense boundary so the
 * page header renders immediately.
 */
import { PageHeader } from "@/components/ui/page-header";
import {
  Section,
  LoadingState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { FleetListSection } from "./fleet-list-section";
import { FleetDetailSection } from "./fleet-detail-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ fanout?: string }>;
}

export default async function FleetPage({ params, searchParams }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { fanout } = await searchParams;
  const { ctx, canManage } = await resolveWorkbenchScope(orgSlug, workspaceSlug);

  return (
    <div className="flex flex-col gap-5" data-testid="fleet-page">
      <PageHeader
        title="Fleet"
        description="Subagent fan-out observability — status, children, and lineage for every parallel dispatch in this workspace."
      />
      {fanout ? (
        <Section fallback={<LoadingState variant="detail" />}>
          <FleetDetailSection
            fanoutId={fanout}
            orgId={ctx.orgId}
            workspaceId={ctx.workspaceId}
            userId={ctx.userId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            canManage={canManage}
          />
        </Section>
      ) : (
        <Section fallback={<LoadingState variant="table" />}>
          <FleetListSection
            orgId={ctx.orgId}
            workspaceId={ctx.workspaceId}
            userId={ctx.userId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            canManage={canManage}
          />
        </Section>
      )}
    </div>
  );
}
