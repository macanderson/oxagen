/**
 * page.tsx — Workspace → Knowledge → Graph.
 *
 * Renders:
 *  - Pending inference review list (InferencePendingList)
 *  - Approved edge browser (SemanticEdgeViewer)
 *
 * Both sections are server-fetched via invoke() then passed to client components
 * that support approve/reject mutations.
 */
import { notFound } from "next/navigation";
import { Layers, GitGraph } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import type { SemanticEdgeSuggestOutput } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import type { SemanticEdgeListOutput } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { InferencePendingList } from "@/components/knowledge/graph/inference-pending-list";
import { SemanticEdgeViewer } from "@/components/knowledge/graph/semantic-edge-viewer";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function KnowledgeGraphPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  // Fetch pending inferences (approval queue).
  let pendingSuggestions: SemanticEdgeSuggestOutput["suggestions"] = [];
  let pendingTotal = 0;
  try {
    const result = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () => invoke("semantic.edge.suggest", { limit: 50 }, ctx, { surface: "agent" }),
    ) as SemanticEdgeSuggestOutput;
    pendingSuggestions = result.suggestions;
    pendingTotal = result.total;
  } catch (e) {
    console.error("semantic.edge.suggest failed:", e);
  }

  // Fetch approved edges for the edge browser.
  let approvedEdges: SemanticEdgeListOutput["edges"] = [];
  let approvedTotal = 0;
  try {
    const result = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () => invoke("semantic.edge.list", { limit: 100, offset: 0 }, ctx, { surface: "agent" }),
    ) as SemanticEdgeListOutput;
    // Show only approved edges in the viewer.
    approvedEdges = result.edges.filter((e) => e.approved === true);
    approvedTotal = approvedEdges.length;
  } catch (e) {
    console.error("semantic.edge.list failed:", e);
  }

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      {/* Pending inferences section */}
      <section aria-labelledby="pending-inferences-heading">
        <div className="mb-4 flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2
            id="pending-inferences-heading"
            className="text-sm font-semibold text-foreground"
          >
            Pending Inferences
          </h2>
          {pendingTotal > 0 && (
            <span className="inline-flex items-center rounded-full bg-warning/12 px-2 py-0.5 text-[10px] font-semibold text-warning">
              {pendingTotal}
            </span>
          )}
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          These relationship candidates were inferred by the LLM during ingestion. Review and
          approve edges to materialise them permanently in the knowledge graph.
        </p>
        <InferencePendingList
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialSuggestions={pendingSuggestions}
          total={pendingTotal}
        />
      </section>

      {/* Approved edge browser */}
      <section aria-labelledby="approved-edges-heading">
        <div className="mb-4 flex items-center gap-2">
          <GitGraph className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h2
            id="approved-edges-heading"
            className="text-sm font-semibold text-foreground"
          >
            Approved Edges
          </h2>
          {approvedTotal > 0 && (
            <span className="inline-flex items-center rounded-full bg-success/12 px-2 py-0.5 text-[10px] font-semibold text-success">
              {approvedTotal}
            </span>
          )}
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Approved semantic edges form permanent relationships in the knowledge graph, visible to
          agents across this workspace.
        </p>
        <SemanticEdgeViewer
          edges={approvedEdges}
          total={approvedTotal}
        />
      </section>
    </div>
  );
}
