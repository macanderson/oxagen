/**
 * Recent Results Component
 *
 * Displays the most recent REAL benchmark results (read + validated from
 * results/) with provenance. Shows an honest empty state until a run has been
 * recorded — no placeholder rows.
 */

import { readResults, recentResults } from "@/lib/results";

export function RecentResults() {
  const results = recentResults(readResults());

  if (results.length === 0) {
    return (
      <div className="arena-card rounded-xl p-10 text-center">
        <p className="text-2xl">📭</p>
        <p className="mt-2 text-sm font-medium text-foreground">
          No benchmark results yet
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run a benchmark above (or <code className="text-xs">pnpm run:benchmark</code>).
          Measured results are written to <code className="text-xs">results/</code>{" "}
          and appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="arena-card overflow-hidden rounded-xl">
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Task</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Duration</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
              <th className="px-4 py-3 text-right font-medium">Run Date</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr
                key={result.id}
                className="row-hover border-b border-border/50 last:border-0"
              >
                <td className="px-4 py-3 font-mono text-xs text-foreground">
                  {result.taskId}
                </td>
                <td className="px-4 py-3">
                  <AgentBadge agentType={result.agentType} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <code className="text-xs">{result.model}</code>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge success={result.success} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {result.durationSeconds.toFixed(1)}s
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  ${result.totalCost.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {result.runDate
                    ? new Date(result.runDate).toLocaleDateString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ success }: { success: boolean }) {
  if (success) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-success)]/40 bg-[var(--color-success)]/12 px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
        ✓ Passed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/12 px-2 py-0.5 text-xs font-medium text-[var(--color-danger)]">
      ✗ Failed
    </span>
  );
}

export function AgentBadge({ agentType }: { agentType: string }) {
  const styles = {
    oxagen: "border-[var(--_ember-flame)]/40 bg-[var(--_ember-flame)]/12 text-[var(--_ember-flame)]",
    stella: "border-amber-400/40 bg-amber-400/12 text-amber-300",
    "claude-code": "border-violet-400/40 bg-violet-400/12 text-violet-300",
  } as const;

  // `styles` is a fixed record; index access is typed as always-present, so a
  // `??` fallback reads as unnecessary. Gate on `Object.hasOwn` instead so the
  // unknown-agent fallback stays and the type stops lying about coverage.
  const style = Object.hasOwn(styles, agentType)
    ? styles[agentType as keyof typeof styles]
    : "border-border bg-muted text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {agentType}
    </span>
  );
}

RecentResults.Skeleton = function RecentResultsSkeleton() {
  return (
    <div className="arena-card overflow-hidden rounded-xl">
      <div className="h-11 border-b border-border bg-muted/40" />
      <div className="space-y-3 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </div>
  );
};
