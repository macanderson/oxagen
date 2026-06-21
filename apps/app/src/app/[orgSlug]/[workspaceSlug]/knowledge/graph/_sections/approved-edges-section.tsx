/**
 * approved-edges-section.tsx — async Server Component.
 *
 * Fetches semantic.edge.list in isolation so it can stream into its own
 * <Suspense> boundary concurrently with the other sections on the Knowledge →
 * Graph page.
 */
import "@oxagen/handlers/register";
import { GitGraph } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { SemanticEdgeListOutput } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { SemanticEdgeViewer } from "@/components/knowledge/graph/semantic-edge-viewer";

interface ApprovedEdgesSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
}

export async function ApprovedEdgesSection({ orgId, workspaceId, userId }: ApprovedEdgesSectionProps) {
  let approvedEdges: SemanticEdgeListOutput["edges"] = [];
  let approvedTotal = 0;

  try {
    const result = (await runInTenantScope(
      { orgId, workspaceId },
      () =>
        invoke(
          "semantic.edge.list",
          { limit: 100, offset: 0 },
          {
            orgId,
            workspaceId,
            userId,
            apiKeyId: null as string | null,
            requestId: crypto.randomUUID(),
            surface: "app" as const,
            messageId: null as string | null,
          },
          { surface: "agent" },
        ),
    )) as SemanticEdgeListOutput;
    // Show only approved edges in the viewer.
    approvedEdges = result.edges.filter((e) => e.approved === true);
    approvedTotal = approvedEdges.length;
  } catch (e) {
    console.error("semantic.edge.list failed:", e);
  }

  return (
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
  );
}
