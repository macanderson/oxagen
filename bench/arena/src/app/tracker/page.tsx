/**
 * Arena Progress Page
 *
 * Longitudinal view of agent improvement over time, read from the tracker
 * history (`tracker/history.json`, written by `scripts/update-tracker.ts`).
 * Shows per-agent trend cards (success rate, cost, duration with deltas vs. the
 * first recorded snapshot) and the full timeline. Honest empty state until
 * history exists.
 */

import { DashboardShell } from "@/components/dashboard-shell";
import { AgentBadge } from "@/components/recent-results";
import { readHistory, historySeries, type HistorySeries } from "@/lib/results";
import type { TrackerEntry } from "@/lib/types";

export default function ProgressPage() {
  const entries = readHistory();
  const series = historySeries(entries);

  return (
    <DashboardShell>
      <div className="space-y-10">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Progress</h1>
          <p className="text-muted-foreground">
            Longitudinal tracking of agent improvement — success rate, cost, and
            duration over time. Every point is a recorded benchmark snapshot.
          </p>
        </div>

        {series.length === 0 ? (
          <EmptyHistory />
        ) : (
          <>
            <section className="grid gap-4 md:grid-cols-2">
              {series.map((s) => (
                <TrendCard key={`${s.agentType}-${s.model}`} series={s} />
              ))}
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold tracking-tight">
                History timeline
              </h2>
              <HistoryTable entries={entries} />
            </section>
          </>
        )}
      </div>
    </DashboardShell>
  );
}

function EmptyHistory() {
  return (
    <div className="arena-card rounded-xl p-10 text-center">
      <p className="text-2xl">📈</p>
      <p className="mt-2 text-sm font-medium text-foreground">
        No progress history yet
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Run benchmarks, then <code className="text-xs">pnpm tracker:update</code>{" "}
        records a snapshot into{" "}
        <code className="text-xs">tracker/history.json</code> that appears here.
      </p>
    </div>
  );
}

function TrendCard({ series }: { series: HistorySeries }) {
  const { latest, first, points, successRateDelta, costDelta } = series;
  const srValues = points.map((p) => p.successRate);
  const maxSr = Math.max(...srValues, latest.successRate);

  return (
    <div className="arena-card rounded-2xl p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AgentBadge agentType={series.agentType} />
          <code className="text-xs text-muted-foreground">{series.model}</code>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {points.length} snapshot{points.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-5 flex items-end justify-between">
        <div>
          <p className="eyebrow text-muted-foreground">Success rate</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">
            {(latest.successRate * 100).toFixed(1)}%
          </p>
        </div>
        <TrendDelta value={successRateDelta * 100} suffix="pp" upIsGood />
      </div>

      <div className="mt-4">
        <Sparkline values={srValues} max={maxSr} />
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{first.date}</span>
          <span>{latest.date}</span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/60 pt-4">
        <MetricLine
          label="Avg cost"
          value={`$${latest.avgCost.toFixed(2)}`}
          delta={costDelta}
          suffix="$"
          upIsGood={false}
        />
        <MetricLine
          label="Avg duration"
          value={`${latest.avgDuration.toFixed(1)}s`}
          delta={latest.avgDuration - first.avgDuration}
          suffix="s"
          upIsGood={false}
        />
      </div>

      {latest.notes ? (
        <p className="mt-4 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Latest note:</span>{" "}
          {latest.notes}
        </p>
      ) : null}
    </div>
  );
}

function MetricLine({
  label,
  value,
  delta,
  suffix,
  upIsGood,
}: {
  label: string;
  value: string;
  delta: number;
  suffix: string;
  upIsGood: boolean;
}) {
  return (
    <div>
      <p className="eyebrow text-muted-foreground">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <TrendDelta value={delta} suffix={suffix} upIsGood={upIsGood} />
      </div>
    </div>
  );
}

/**
 * A colored delta chip. `upIsGood` decides whether an increase is rendered as
 * good (green) or bad (red) — success rate improves upward, cost/duration
 * improve downward.
 */
function TrendDelta({
  value,
  suffix,
  upIsGood,
}: {
  value: number;
  suffix: string;
  upIsGood: boolean;
}) {
  if (Math.abs(value) < 0.05) {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        no change
      </span>
    );
  }

  const positive = value > 0;
  const good = positive === upIsGood;
  const color = good
    ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/12 text-[var(--color-success)]"
    : "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/12 text-[var(--color-danger)]";
  const arrow = positive ? "▲" : "▼";
  const magnitude = Math.abs(value);
  const shown =
    suffix === "$"
      ? `$${magnitude.toFixed(2)}`
      : `${magnitude.toFixed(1)}${suffix}`;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {arrow} {shown}
    </span>
  );
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const ceiling = max > 0 ? max : 1;
  return (
    <div className="flex h-10 items-end gap-1" aria-hidden>
      {values.map((value, index) => (
        <div
          key={index}
          className="flex-1 rounded-sm bg-[var(--_ember-flame)]/70"
          style={{ height: `${Math.max(6, (value / ceiling) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function HistoryTable({ entries }: { entries: TrackerEntry[] }) {
  // Newest first for the timeline reading order.
  const rows = [...entries].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="arena-card overflow-hidden rounded-xl">
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Agent</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 text-right font-medium">Success</th>
              <th className="px-4 py-3 text-right font-medium">Avg Cost</th>
              <th className="px-4 py-3 text-right font-medium">Avg Duration</th>
              <th className="px-4 py-3 text-right font-medium">Tasks</th>
              <th className="px-4 py-3 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry, index) => (
              <tr
                key={`${entry.date}-${entry.agentType}-${entry.model}-${index}`}
                className="row-hover border-b border-border/50 last:border-0"
              >
                <td className="px-4 py-3 tabular-nums text-muted-foreground">
                  {entry.date}
                </td>
                <td className="px-4 py-3">
                  <AgentBadge agentType={entry.agentType} />
                </td>
                <td className="px-4 py-3">
                  <code className="text-xs text-muted-foreground">
                    {entry.model}
                  </code>
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                  {(entry.successRate * 100).toFixed(1)}%
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  ${entry.avgCost.toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {entry.avgDuration.toFixed(1)}s
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {entry.tasksCompleted}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {entry.notes ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
