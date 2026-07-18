/**
 * page.tsx — Workspace → Knowledge → Citations.
 *
 * Server component that resolves auth + org/workspace scope, then streams the
 * citation-analytics dashboard (agent.memory_citation.stats /
 * "get_citation_stats") inside its own <Suspense> boundary — mirrors
 * knowledge/memory/page.tsx's Section-per-fetch pattern, but this page has a
 * single capability call, so it's one dashboard section rather than several.
 *
 * The period switcher renders outside the Suspense boundary (it's pure links,
 * no fetch dependency) so it stays interactive even while the dashboard is
 * loading or has failed to load.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { CitationsPeriodPicker } from "@/components/knowledge/citations/citations-period-picker";
import { CitationsDashboardSkeleton } from "@/components/knowledge/citations/citations-dashboard-skeleton";
import { workspace } from "@/lib/routes";
import { CitationsDashboardSection } from "./citations-dashboard-section";
import { parseDays } from "./citations-format";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ days?: string }>;
}

export default async function KnowledgeCitationsPage({
  params,
  searchParams,
}: PageProps) {
  const [{ orgSlug, workspaceSlug }, sp] = await Promise.all([
    params,
    searchParams,
  ]);
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  const days = parseDays(sp.days);
  const basePath = workspace.knowledge.citations({ orgSlug, workspaceSlug });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Which memories and graph nodes agents actually cite, how useful those
          citations were, and where promoted rules get violated.
        </p>
        <CitationsPeriodPicker basePath={basePath} active={days} />
      </div>

      <Suspense fallback={<CitationsDashboardSkeleton />}>
        <CitationsDashboardSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          days={days}
        />
      </Suspense>
    </div>
  );
}
