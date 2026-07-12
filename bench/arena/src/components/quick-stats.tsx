/**
 * Quick Stats Component
 *
 * Displays high-level benchmark statistics as a row of stat cards, aggregated
 * from REAL measured results under results/. When no runs exist yet, every
 * card reads zero — Arena never invents a number.
 */

import { readResults, computeQuickStats } from "@/lib/results";

export function QuickStats() {
  const stats = computeQuickStats(readResults());
  const hasData = stats.totalResults > 0;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Total Results"
        value={stats.totalResults.toLocaleString()}
        change={hasData ? "measured runs" : "no runs yet"}
      />
      <StatCard
        label="Success Rate"
        value={hasData ? `${(stats.successRate * 100).toFixed(1)}%` : "—"}
        change="across all runs"
      />
      <StatCard
        label="Total Cost"
        value={`$${stats.totalCost.toFixed(2)}`}
        change="across all runs"
      />
      <StatCard
        label="Avg Duration"
        value={hasData ? `${stats.avgDuration.toFixed(1)}s` : "—"}
        change="per task"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  change,
  trend,
}: {
  label: string;
  value: string;
  change?: string;
  trend?: "up" | "down" | "neutral";
}) {
  const trendColor =
    trend === "up"
      ? "text-[var(--color-success)]"
      : trend === "down"
        ? "text-[var(--color-danger)]"
        : "text-muted-foreground";

  return (
    <div className="arena-card rounded-xl p-5">
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      {change && (
        <p className={`mt-1.5 flex items-center gap-1 text-xs ${trendColor}`}>
          {trend === "up" && <span aria-hidden>▲</span>}
          {trend === "down" && <span aria-hidden>▼</span>}
          {change}
        </p>
      )}
    </div>
  );
}

QuickStats.Skeleton = function QuickStatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="arena-card animate-pulse space-y-2 rounded-xl p-5">
          <div className="h-3 w-20 rounded bg-muted" />
          <div className="h-8 w-16 rounded bg-muted" />
          <div className="h-3 w-32 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
};
