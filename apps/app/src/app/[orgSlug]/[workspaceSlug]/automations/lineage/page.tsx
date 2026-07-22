/**
 * page.tsx — Workspace → Automations → Lineage (issue #1078: the
 * fleet-lineage explorer).
 *
 * The read surface for `query_lineage` — the dispatch tree rooted at one
 * `agent.subagent_fanouts` row. Natural neighbour/drill-through target of
 * Workflows & swarm runs (a workflow run's own fan-outs land here). Server
 * component: renders the shared Automations header + tab strip immediately,
 * then streams the dispatch data into <LineageSection> inside a Suspense
 * boundary — matching automations/page.tsx and workflows/page.tsx exactly.
 *
 * `dispatchId` deep-links via `?dispatchId=` (mirrors knowledge/graph's
 * `?focus=`); optional `maxDepth`/`maxNodes` let the "load deeper"/"load
 * more" links in LineageExplorer re-query past the contract's defaults.
 * Next 16: searchParams is a Promise.
 */
import { Suspense } from "react";
import { TableSkeleton } from "@/components/loading";
import { AutomationsHeader } from "@/app/[orgSlug]/[workspaceSlug]/automations/_components/automations-header";
import { LineageSection } from "./lineage-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{
    dispatchId?: string | string[];
    maxDepth?: string | string[];
    maxNodes?: string | string[];
  }>;
}

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LineagePage({ params, searchParams }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const search = await searchParams;
  const dispatchId = firstOf(search.dispatchId);
  const maxDepthRaw = firstOf(search.maxDepth);
  const maxNodesRaw = firstOf(search.maxNodes);
  const maxDepth = maxDepthRaw ? Number.parseInt(maxDepthRaw, 10) : undefined;
  const maxNodes = maxNodesRaw ? Number.parseInt(maxNodesRaw, 10) : undefined;
  const routeCtx = { orgSlug, workspaceSlug };

  return (
    <div className="flex flex-col gap-5">
      <AutomationsHeader
        ctx={routeCtx}
        title="Automations"
        description="Fleet lineage — the dispatch tree for a subagent fan-out, with per-run spend, principal, and delegation-ceiling flags."
      />
      <Suspense
        fallback={<TableSkeleton rows={6} cols={6} />}
        key={dispatchId ?? "picker"}
      >
        <LineageSection
          ctx={routeCtx}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          {...(dispatchId ? { dispatchId } : {})}
          {...(maxDepth !== undefined && Number.isFinite(maxDepth)
            ? { maxDepth }
            : {})}
          {...(maxNodes !== undefined && Number.isFinite(maxNodes)
            ? { maxNodes }
            : {})}
        />
      </Suspense>
    </div>
  );
}
