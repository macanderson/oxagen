import { Network } from "lucide-react";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";

export interface TopCitedNodesListProps {
  nodes: AgentMemoryCitationStatsOutput["topNodes"];
}

/**
 * Most-cited non-memory graph nodes. Cited via the shared NodeRef chip
 * (colour-coded domain label, hover/click property popover) — never a raw
 * UUID, per the citation convention every graph reference in this app follows.
 */
export function TopCitedNodesList({ nodes }: TopCitedNodesListProps) {
  return (
    <section aria-labelledby="top-cited-nodes-heading">
      <div className="mb-3 flex items-center gap-2">
        <Network className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h3
          id="top-cited-nodes-heading"
          className="text-sm font-semibold text-foreground"
        >
          Top Cited Graph Nodes
        </h3>
      </div>
      {nodes.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No graph nodes cited"
          description="Agents haven't cited a non-memory graph node in this window yet."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {nodes.map((row, i) => (
            <li
              key={row.node.id ?? `candidate-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
            >
              <NodeRef node={row.node} className="min-w-0" />
              <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
                <span>{row.citationCount.toLocaleString()} cites</span>
                <span>{row.decisiveCount.toLocaleString()} decisive</span>
                <span>{row.ignoredCount.toLocaleString()} ignored</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
