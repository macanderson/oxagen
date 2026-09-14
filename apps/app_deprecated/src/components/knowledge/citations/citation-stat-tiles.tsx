import { Stat, StatGroup } from "@/components/ui/stat";
import type { AgentMemoryCitationStatsOutput } from "@oxagen/oxagen/contracts/agent.memory_citation.stats";

export interface CitationStatTilesProps {
  totals: AgentMemoryCitationStatsOutput["totals"];
  windowDays: number;
}

/** KPI row for the Citations dashboard — server-safe, no client JS. */
export function CitationStatTiles({
  totals,
  windowDays,
}: CitationStatTilesProps) {
  return (
    <StatGroup columns={4}>
      <Stat
        label="Citations"
        value={totals.citations.toLocaleString()}
        hint={`last ${windowDays} days`}
      />
      <Stat
        label="Executions citing"
        value={totals.executions.toLocaleString()}
        hint="distinct executions that cited anything"
      />
      <Stat
        label="Memories cited"
        value={totals.memoriesCited.toLocaleString()}
        hint="distinct AgentMemory records"
      />
      <Stat
        label="Graph nodes cited"
        value={totals.nodesCited.toLocaleString()}
        hint="distinct non-memory nodes"
      />
    </StatGroup>
  );
}
