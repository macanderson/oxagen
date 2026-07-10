/**
 * page.tsx — Workspace → Activity.
 *
 * Recent agent runs (top-level executions), newest first, each linking to its
 * span-tree trace. Server component: resolves auth + org/workspace scope, then
 * defers the live agent.execution.list fetch to <ActivitySection> inside a
 * Suspense boundary.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/loading";
import { ActivitySection } from "./activity-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ before?: string }>;
}

export default async function ActivityPage({ params, searchParams }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { before } = await searchParams;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();
  await assertOrgMember(org.id, session.user.id);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Activity"
        description="Recent agent runs. Open any run to inspect its span tree — steps, tool calls, durations, and cost."
      />
      <Suspense fallback={<TableSkeleton rows={8} cols={5} />}>
        <ActivitySection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          before={before}
        />
      </Suspense>
    </div>
  );
}
