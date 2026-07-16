/**
 * page.tsx — Workspace → Overview (the control-plane heads-up display).
 *
 * A metering-forward, graph-grounded workspace home: a KPI strip (spend, tokens,
 * runs, credit balance), a Knowledge-graph hero (live subgraph preview + node/
 * edge/inference stats + node-creation growth), agent activity, automations,
 * usage charts, memory capture, and source health — each independently
 * Suspense-streamed and fail-open (one tile's data source failing never blocks
 * the others). Ask remains the default conversational front door via the nav;
 * this page gives operators a reason to land here first.
 *
 * See docs/web-app-2.0/workspace/overview/spec.md.
 */
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { PageHeader } from "@/components/ui/page-header";
import { Section, LoadingState } from "./_shared/components";
import { MeteringKpiStrip } from "./_overview/metering-kpi-strip";
import { GraphHero } from "./_overview/graph-hero";
import { AutomationsPanel } from "./_overview/automations-panel";
import { UsagePanel } from "./_overview/usage-panel";
import { MemoriesPanel } from "./_overview/memories-panel";
import { SourcesTile } from "./_overview/sources-section";
import { ReviewLinks } from "./_overview/review-links";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkspaceOverviewPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  // Session and org resolution are independent DB round-trips — overlap them
  // on this hottest-path page (same pattern as billing/revenue/page.tsx).
  const [session, org] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
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
        description="A live heads-up display of spend, activity, automations, memory, and knowledge-graph grounding for this workspace."
      />

      {/* KPI strip — the metering wedge at a glance */}
      <Section fallback={<LoadingState variant="cards" />}>
        <MeteringKpiStrip {...tileProps} />
      </Section>

      {/* Knowledge-graph hero — the grounding wedge, made visual */}
      <Section fallback={<LoadingState variant="cards" />}>
        <GraphHero {...tileProps} />
      </Section>

      {/* Automations */}
      <Section fallback={<LoadingState variant="cards" />}>
        <AutomationsPanel {...tileProps} />
      </Section>

      {/* Usage charts + Memory capture */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section fallback={<LoadingState variant="cards" />}>
          <UsagePanel {...tileProps} />
        </Section>
        <Section fallback={<LoadingState variant="cards" />}>
          <MemoriesPanel {...tileProps} />
        </Section>
      </div>

      {/* Source health + Needs attention */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section fallback={<LoadingState variant="cards" />}>
          <SourcesTile {...tileProps} />
        </Section>
        <ReviewLinks orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      </div>
    </div>
  );
}
