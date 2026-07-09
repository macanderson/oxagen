/**
 * graph-stats-section.tsx — async Server Component.
 *
 * Fetches graph.stats in isolation so it can stream into its own <Suspense>
 * boundary concurrently with the other sections on the Knowledge → Graph page.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { GraphStatsBoxes, type GraphStatsData } from "@/components/knowledge/graph/graph-stats";

interface GraphStatsSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
}

export async function GraphStatsSection({ orgId, workspaceId, userId }: GraphStatsSectionProps) {
  let graphStats: GraphStatsData | null = null;

  try {
    graphStats = (await runInTenantScope(
      { orgId, workspaceId },
      () =>
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
    console.error("graph.stats failed:", e);
  }

  if (!graphStats) return null;

  return (
    <section aria-label="Graph statistics">
      <GraphStatsBoxes stats={graphStats} />
    </section>
  );
}
