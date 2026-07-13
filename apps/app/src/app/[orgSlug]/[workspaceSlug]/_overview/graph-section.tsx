/**
 * graph-section.tsx — Overview → Graph grounding tile.
 *
 * Node/edge/inference/source counts via graph.stats, rendered with the shared
 * <GraphStatsBoxes> presentational component (also used by
 * knowledge/inference/_sections/graph-stats-section.tsx and the chat
 * generative-UI registry) — one implementation of "show graph stats nicely",
 * reused rather than forked.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import Link from "next/link";
import { Network } from "lucide-react";
import { GraphStatsBoxes, type GraphStatsData } from "@/components/knowledge/graph/graph-stats";
import { workspace } from "@/lib/routes";
import { Tile, EmptyState, ErrorState } from "../_shared/components";

interface GraphTileProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

export async function GraphTile({ orgId, workspaceId, userId, orgSlug, workspaceSlug }: GraphTileProps) {
  const ctx = { orgSlug, workspaceSlug };
  const exploreHref = workspace.knowledge.graph(ctx);
  const reposHref = workspace.knowledge.sources(ctx);

  let stats: GraphStatsData | null = null;
  let failed = false;
  try {
    stats = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke(
        "get_graph_stats",
        { includeByType: false },
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
    )) as GraphStatsData;
  } catch (e) {
    console.error("get_graph_stats failed:", e);
    failed = true;
  }

  const footer = (
    <Link href={exploreHref} className="text-sm font-medium text-primary hover:underline">
      Explore graph →
    </Link>
  );

  return (
    <div data-testid="overview-graph-tile">
      <Tile title="Graph grounding" footer={footer}>
        {failed || !stats ? (
          <ErrorState
            title="Graph stats unavailable"
            description="Could not load graph grounding stats."
          />
        ) : stats.nodeCount === 0 ? (
          <EmptyState
            icon={Network}
            title="No graph data yet"
            description="Connect a source to start grounding answers."
            action={
              <Link href={reposHref} className="text-sm font-medium text-primary hover:underline">
                Connect a source →
              </Link>
            }
          />
        ) : (
          <GraphStatsBoxes stats={stats} />
        )}
      </Tile>
    </div>
  );
}
