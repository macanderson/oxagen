/**
 * Agent Comparison Component
 *
 * Side-by-side comparison of agent performance with statistical rigor,
 * aggregated from REAL measured results (Wilson 95% CI per agent+model). Shows
 * an honest empty state until at least one run has been recorded.
 */

import { AgentBadge } from "@/components/recent-results";
import { readResults, agentComparison } from "@/lib/results";

const STAT_NOTES = [
  ["Confidence Intervals", "95% CI calculated via the Wilson score interval."],
  ["Runs", "Multiple runs per task-agent pair for reliability."],
  ["Provenance", "Every result includes a run ID, date, and git SHA."],
] as const;

export function AgentComparison() {
  const data = agentComparison(readResults());
  const ranked = [...data.agents].sort((a, b) => b.successRate - a.successRate);
  const topRate = ranked[0]?.successRate || 1;

  return (
    <div className="space-y-4">
      {/* Comparison Table */}
      <div className="arena-card overflow-hidden rounded-xl">
        {ranked.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-2xl">⚖️</p>
            <p className="mt-2 text-sm font-medium text-foreground">
              No agents to compare yet
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Comparisons appear once measured runs exist for two or more agents.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto thin-scroll">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Agent</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 text-right font-medium">Runs</th>
                  <th className="px-4 py-3 font-medium">Success Rate</th>
                  <th className="px-4 py-3 text-right font-medium">95% CI</th>
                  <th className="px-4 py-3 text-right font-medium">Avg Duration</th>
                  <th className="px-4 py-3 text-right font-medium">Avg Cost</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((agent, index) => (
                  <tr
                    key={`${agent.type}-${agent.model}`}
                    className="row-hover border-b border-border/50 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <AgentBadge agentType={agent.type} />
                        {index === 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--_ember-flame)]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--_ember-flame)]">
                            ↑ Best
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-muted-foreground">{agent.model}</code>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {agent.runCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div
                            className="absolute inset-y-0 left-0 rounded-full bg-[var(--_ember-flame)]"
                            style={{ width: `${(agent.successRate / topRate) * 100}%` }}
                          />
                        </div>
                        <span className="font-semibold tabular-nums text-foreground">
                          {(agent.successRate * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      [{(agent.confidenceInterval[0] * 100).toFixed(0)}%,{" "}
                      {(agent.confidenceInterval[1] * 100).toFixed(0)}%]
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {agent.avgDuration.toFixed(1)}s
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      ${agent.avgCost.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Statistical Note */}
      <div className="arena-card rounded-xl p-5">
        <div className="flex items-center gap-2">
          <span className="text-base">📊</span>
          <p className="text-sm font-semibold">Statistical rigor</p>
        </div>
        <ul className="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
          {STAT_NOTES.map(([term, desc]) => (
            <li key={term} className="flex gap-2">
              <span className="text-[var(--_ember-flame)]">•</span>
              <span>
                <strong className="text-foreground">{term}:</strong> {desc}
              </span>
            </li>
          ))}
          <li className="flex gap-2">
            <span className="text-[var(--_ember-flame)]">•</span>
            <span>
              <strong className="text-foreground">Significance:</strong>{" "}
              {data.significantDifference
                ? "Significant difference detected (non-overlapping 95% CIs)."
                : "No significant difference detected."}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

AgentComparison.Skeleton = function AgentComparisonSkeleton() {
  return (
    <div className="space-y-4">
      <div className="arena-card h-40 animate-pulse rounded-xl" />
      <div className="arena-card h-28 animate-pulse rounded-xl" />
    </div>
  );
};
