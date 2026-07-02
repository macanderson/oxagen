/**
 * page.tsx — Workspace → Knowledge → Inference.
 *
 * Renders three independent <Suspense> sections that stream concurrently:
 *  - Graph statistics (graph.stats)
 *  - Pending inference review list (semantic.edge.suggest)
 *  - Approved edge browser (semantic.edge.list)
 *
 * The auth/resolve work (cheap, security-critical) runs sequentially first.
 * The three data fetches then run in parallel — each section owns its own
 * invoke() call and streams in independently as its data arrives.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { StatCardsSkeleton } from "@/components/loading";
import { TableSkeleton } from "@/components/loading";
import { GraphStatsSection } from "./_sections/graph-stats-section";
import { PendingInferencesSection } from "./_sections/pending-inferences-section";
import { ApprovedEdgesSection } from "./_sections/approved-edges-section";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function KnowledgeInferencePage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  const orgId = org.id;
  const workspaceId = ws.id;
  const userId = session.user.id;

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      {/* Graph statistics — node / edge counts at a glance. */}
      <Suspense fallback={<StatCardsSkeleton count={4} />}>
        <GraphStatsSection orgId={orgId} workspaceId={workspaceId} userId={userId} />
      </Suspense>

      {/* Pending inferences section */}
      <Suspense
        fallback={
          <section aria-labelledby="pending-inferences-heading-skeleton">
            <div className="mb-4 h-5 w-40 rounded bg-muted animate-pulse" aria-hidden="true" />
            <div className="mb-4 h-3 w-64 rounded bg-muted/60 animate-pulse" aria-hidden="true" />
            <TableSkeleton rows={3} cols={2} />
          </section>
        }
      >
        <PendingInferencesSection
          orgId={orgId}
          workspaceId={workspaceId}
          userId={userId}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </Suspense>

      {/* Approved edge browser */}
      <Suspense
        fallback={
          <section aria-labelledby="approved-edges-heading-skeleton">
            <div className="mb-4 h-5 w-36 rounded bg-muted animate-pulse" aria-hidden="true" />
            <div className="mb-4 h-3 w-72 rounded bg-muted/60 animate-pulse" aria-hidden="true" />
            <TableSkeleton rows={4} cols={3} />
          </section>
        }
      >
        <ApprovedEdgesSection orgId={orgId} workspaceId={workspaceId} userId={userId} />
      </Suspense>
    </div>
  );
}
