/**
 * page.tsx — Workspace → Overview.
 *
 * Metering-forward workspace home: spend, recent runs, graph grounding, and
 * source health at a glance, each independently Suspense-streamed and
 * fail-open (one tile's data source failing never blocks the others), plus a
 * static "needs attention" quick-links row. Replaces the previous one-line
 * redirect to /ask — Ask remains the default conversational front door via
 * the nav; this page gives operators a reason to land here first.
 *
 * See docs/web-app-2.0/workspace/overview/spec.md.
 */
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { PageHeader } from "@/components/ui/page-header";
import { Section, LoadingState } from "./_shared/components";
import { SpendTile } from "./_overview/spend-section";
import { RunsTile } from "./_overview/runs-section";
import { GraphTile } from "./_overview/graph-section";
import { SourcesTile } from "./_overview/sources-section";
import { ReviewLinks } from "./_overview/review-links";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkspaceOverviewPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();
  await assertOrgMember(org.id, session.user.id);

  const tileProps = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    orgSlug,
    workspaceSlug,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Spend, activity, graph grounding, and source health for this workspace."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Section fallback={<LoadingState variant="cards" />}>
          <SpendTile {...tileProps} />
        </Section>
        <Section fallback={<LoadingState variant="cards" />}>
          <RunsTile {...tileProps} />
        </Section>
        <Section fallback={<LoadingState variant="cards" />}>
          <GraphTile {...tileProps} />
        </Section>
        <Section fallback={<LoadingState variant="cards" />}>
          <SourcesTile {...tileProps} />
        </Section>
      </div>

      <ReviewLinks orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
    </div>
  );
}
