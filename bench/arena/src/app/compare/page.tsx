/**
 * Arena Compare Page
 *
 * Full head-to-head comparison of agents on measured results: the statistical
 * summary (Wilson 95% CI per agent, via <AgentComparison />) plus a per-task
 * breakdown matrix showing how each agent did on each task. Real data only —
 * honest empty state until runs exist.
 */

import { Suspense } from "react";

import { DashboardShell } from "@/components/dashboard-shell";
import { AgentComparison } from "@/components/agent-comparison";
import { AgentBadge } from "@/components/recent-results";
import {
  readResults,
  taskBreakdown,
  type TaskBreakdownCell,
  type TaskBreakdownData,
} from "@/lib/results";

export default function ComparePage() {
  const breakdown = taskBreakdown(readResults());

  return (
    <DashboardShell>
      <div className="space-y-10">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Compare agents</h1>
          <p className="text-muted-foreground">
            Same tasks, same harness — with statistical confidence intervals and
            a per-task breakdown. Measured runs only, no simulated scores.
          </p>
        </div>

        {/* Statistical head-to-head (reuses the dashboard component) */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">Head-to-head</h2>
          <Suspense fallback={<AgentComparison.Skeleton />}>
            <AgentComparison />
          </Suspense>
        </section>

        {/* Per-task breakdown */}
        <section className="space-y-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-2xl font-semibold tracking-tight">
              Per-task breakdown
            </h2>
            <span className="eyebrow text-muted-foreground">
              success rate &amp; cost by task
            </span>
          </div>
          <TaskBreakdownTable data={breakdown} />
        </section>
      </div>
    </DashboardShell>
  );
}

function TaskBreakdownTable({ data }: { data: TaskBreakdownData }) {
  if (data.rows.length === 0) {
    return (
      <div className="arena-card rounded-xl p-10 text-center">
        <p className="text-2xl">🗂️</p>
        <p className="mt-2 text-sm font-medium text-foreground">
          No tasks to break down yet
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-task results appear once a benchmark has run (
          <code className="text-xs">pnpm run:benchmark</code>).
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
              {data.agents.map((agent) => (
                <th key={agent.key} className="px-4 py-3 font-medium">
                  <AgentBadge agentType={agent.type} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr
                key={row.taskId}
                className="row-hover border-b border-border/50 last:border-0"
              >
                <td className="px-4 py-3 font-mono text-xs text-foreground">
                  {row.taskId}
                </td>
                {data.agents.map((agent) => {
                  const cell = row.cells[agent.key];
                  return (
                    <td key={agent.key} className="px-4 py-3 align-top">
                      {cell ? (
                        <BreakdownCell cell={cell} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownCell({ cell }: { cell: TaskBreakdownCell }) {
  const pct = cell.successRate * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="relative h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--_ember-flame)]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-semibold tabular-nums text-foreground">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        ${cell.avgCost.toFixed(2)} · {cell.runCount} run
        {cell.runCount === 1 ? "" : "s"}
      </div>
    </div>
  );
}
