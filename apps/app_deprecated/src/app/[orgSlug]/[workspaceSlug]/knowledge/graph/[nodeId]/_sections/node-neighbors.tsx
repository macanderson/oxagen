/**
 * node-neighbors.tsx — Async server component for the node-detail Neighbors
 * section (spec: docs/web-app-2.0/workspace/knowledge/graph/node/spec.md).
 *
 * Fetches the node's one-hop neighborhood via ontology.neighbors
 * (get_ontology_neighbors) and renders it as NodeRefLink citation chips
 * grouped by relationship type + direction, each linking to its own
 * node-detail page via workspace.knowledge.node(). Sits inside its own
 * <Suspense> boundary in page.tsx so a slow/large neighborhood never blocks
 * the header/properties from rendering.
 */
import "@oxagen/handlers/register";
import { ArrowLeft, ArrowRight, Network } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { workspace } from "@/lib/routes";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { NodeRefLink } from "@/components/knowledge/graph/node-ref-link";
import { humanizeKey } from "@/components/knowledge/graph-explorer/lib/format";
// One shared mapper per capability shape — the same adapter the graph panels
// use, so the inspectable property bag (description, edge type, direction) is
// identical wherever a neighbor is cited.
import { fromNeighbor } from "../../_panels/node-ref-adapters";
import { groupNeighborsByType } from "./group-neighbors";

export interface NodeNeighborsProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
}

export async function NodeNeighbors({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  nodeId,
}: NodeNeighborsProps) {
  let neighbors: OntologyNeighborsOutput["neighbors"] = [];

  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "get_ontology_neighbors",
        { nodeId, direction: "both", limit: 100 },
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
    )) as OntologyNeighborsOutput;
    neighbors = result.neighbors;
  } catch {
    // Never throw from an RSC — a neighbor-fetch failure degrades to the
    // empty state below rather than taking down the whole node-detail page.
    neighbors = [];
  }

  if (neighbors.length === 0) {
    return <EmptyState icon={Network} title="No connected nodes." />;
  }

  const groups = groupNeighborsByType(neighbors);
  const scope = { orgSlug, workspaceSlug };

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {group.direction === "out" ? (
              <>
                {humanizeKey(group.edgeType)}
                <ArrowRight className="size-3" aria-hidden="true" />
              </>
            ) : (
              <>
                <ArrowLeft className="size-3" aria-hidden="true" />
                {humanizeKey(group.edgeType)}
              </>
            )}
            <span className="font-normal normal-case text-muted-foreground/70">
              ({group.neighbors.length})
            </span>
          </h3>
          <div className="flex flex-wrap gap-x-1 gap-y-1.5">
            {group.neighbors.map((neighbor) => (
              <NodeRefLink
                key={`${neighbor.nodeId}:${neighbor.edgeType}:${neighbor.direction}`}
                node={fromNeighbor(neighbor)}
                href={workspace.knowledge.node(scope, neighbor.nodeId)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
