/**
 * Arena Dashboard — Main Page
 *
 * Web interface for configuring and running agentic coding benchmarks.
 * Scientific honesty, provenance tracking, and fair comparison.
 */

import { Suspense } from "react";

import { DashboardShell } from "@/components/dashboard-shell";
import { QuickStats } from "@/components/quick-stats";
import { BenchmarkRunner } from "@/components/benchmark-runner";
import { RecentResults } from "@/components/recent-results";
import { AgentComparison } from "@/components/agent-comparison";

export default function ArenaDashboard() {
  return (
    <DashboardShell>
      <div className="space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Arena Benchmark Dashboard</h1>
          <p className="text-muted-foreground">
            Scientifically rigorous comparison of agentic coding tools with full provenance tracking.
          </p>
        </div>

        {/* Quick Stats */}
        <Suspense fallback={<QuickStats.Skeleton />}>
          <QuickStats />
        </Suspense>

        {/* Benchmark Runner */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">Run New Benchmark</h2>
          <BenchmarkRunner />
        </section>

        {/* Recent Results */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">Recent Results</h2>
          <Suspense fallback={<RecentResults.Skeleton />}>
            <RecentResults />
          </Suspense>
        </section>

        {/* Agent Comparison */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">Compare Agents</h2>
          <Suspense fallback={<AgentComparison.Skeleton />}>
            <AgentComparison />
          </Suspense>
        </section>

        {/* Scientific Honesty Banner */}
        <section className="border-t pt-8">
          <div className="bg-muted/50 rounded-lg p-6 space-y-3">
            <h3 className="font-semibold text-lg">⚖️ Scientific Honesty Guarantee</h3>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>• <strong>Full Provenance:</strong> Every result includes model, run date, git SHA, and reproduce command</li>
              <li>• <strong>No Cherry-Picking:</strong> All runs are logged, including failures</li>
              <li>• <strong>Statistical Rigor:</strong> Confidence intervals, multiple runs, significance testing</li>
              <li>• <strong>Reproducible:</strong> Open source, auditable methodology</li>
            </ul>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}
