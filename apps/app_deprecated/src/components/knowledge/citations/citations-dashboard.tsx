import { Trophy, ThumbsDown, Quote } from "lucide-react";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";
import { CitationStatTiles } from "./citation-stat-tiles";
import { CitationInfluenceChart } from "./citation-influence-chart";
import { CitationComplianceSummary } from "./citation-compliance-summary";
import { CitationDailyChart } from "./citation-daily-chart";
import { CitedMemoriesTable } from "./cited-memories-table";
import { MostViolatedRulesList } from "./most-violated-rules-list";
import { TopCitedNodesList } from "./top-cited-nodes-list";

export interface CitationsDashboardProps {
  data: AgentMemoryCitationStatsOutput;
  windowDays: number;
  memoryPageHref: string;
}

/**
 * Composes the full Citations dashboard from one get_citation_stats response.
 * Each section degrades to its own empty state independently (a workspace can
 * have plenty of citations but zero violations, or vice versa — that's the
 * "partial" state, not an error), and the whole dashboard degrades to a
 * single explanatory empty state when nothing has been cited at all yet.
 */
export function CitationsDashboard({
  data,
  windowDays,
  memoryPageHref,
}: CitationsDashboardProps) {
  if (data.totals.citations === 0) {
    return (
      <EmptyState
        icon={Quote}
        title="No citations yet"
        description={`No agent execution cited a memory or graph node in the last ${windowDays} days. Citations accrue automatically whenever an agent's response is grounded by AgentMemory recall or a knowledge-graph lookup — run an agent that answers from memory or the graph to see this dashboard populate.`}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <CitationStatTiles totals={data.totals} windowDays={windowDays} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border/60 p-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Citation usefulness
          </p>
          <CitationInfluenceChart byInfluence={data.byInfluence} />
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Compliance outcomes
          </p>
          <CitationComplianceSummary byCompliance={data.byCompliance} />
        </div>
      </div>

      <div className="rounded-lg border border-border/60 p-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Citations over time
        </p>
        <CitationDailyChart daily={data.daily} />
      </div>

      <CitedMemoriesTable
        memories={data.topMemories}
        heading="Most Cited Memories"
        icon={Trophy}
        emptyTitle="No cited memories"
        emptyDescription="No memory has been cited in this window yet."
        memoryPageHref={memoryPageHref}
      />

      <CitedMemoriesTable
        memories={data.leastUsefulMemories}
        heading="Least Useful Memories"
        icon={ThumbsDown}
        emptyTitle="No low-influence memories"
        emptyDescription="Every cited memory shaped at least one outcome — nothing to demote."
        memoryPageHref={memoryPageHref}
      />

      <MostViolatedRulesList
        rules={data.mostViolatedRules}
        memoryPageHref={memoryPageHref}
      />

      <TopCitedNodesList nodes={data.topNodes} />
    </div>
  );
}
