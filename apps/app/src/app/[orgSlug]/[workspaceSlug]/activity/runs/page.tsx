/**
 * page.tsx — Workspace → Activity → Runs.
 *
 * The single home for all run kinds (IA spec §5). Resolves auth/org/workspace,
 * then renders a <Suspense> boundary so the route shell paints immediately
 * while RunsSection streams in the fanout + execution data concurrently.
 * Chat/API/MCP runs join once `activity.runs.list` (ClickHouse) ships.
 */
import { Suspense } from "react";
import type { Metadata } from "next";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { LoadingRegion } from "@/components/loading";
import { PageHeaderSkeleton } from "@/components/loading";
import { TableSkeleton } from "@/components/loading";
import { RunsSection } from "./runs-section";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Runs — Activity",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

function RunsSkeleton() {
  return (
    <LoadingRegion label="Loading runs">
      <PageHeaderSkeleton withAction />
      <TableSkeleton rows={6} cols={5} />
    </LoadingRegion>
  );
}

export default async function ActivityRunsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return (
    <Suspense fallback={<RunsSkeleton />}>
      <RunsSection
        orgId={org.id}
        workspaceId={ws.id}
        userId={session.user.id}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
    </Suspense>
  );
}
