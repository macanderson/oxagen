"use client";

import { useMemo } from "react";
import { HowItWorks } from "@/components/how-it-works";
import { Methodology } from "@/components/methodology";
import { ResolvedRateChart } from "@/components/resolved-rate-chart";
import { ResultsTable } from "@/components/results-table";
import { SourcesList } from "@/components/sources-list";
import { ThirdPartyPanel } from "@/components/third-party-panel";
import { TrustBanner } from "@/components/trust-banner";
import { summarizeRuns } from "@/lib/summary";
import { EVAL_RUNS } from "@/results-data";

/**
 * The Oxagen SWE-bench dashboard — a single honest page, not a simulator with
 * tabs. Every number rendered here traces back to a real `oxagen.eval.v1`
 * result file (`EVAL_RUNS`, see `src/results-data/`) or a cited external
 * source (`src/lib/sources.ts`). See README.md for the provenance policy.
 */
export function BenchmarkDashboard(): React.ReactElement {
  const rows = useMemo(() => summarizeRuns(EVAL_RUNS), []);
  const allSample = rows.length === 0 || rows.every((r) => r.provenance.kind === "sample");

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-ember/15 text-xl">🜂</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-graphite-100">
              Oxagen SWE-bench Benchmarks
            </h1>
            <p className="max-w-xl text-sm text-graphite-400">
              Reproducible agent evaluations on real GitHub issues. Every number here is either
              measured by us (with a reproduce command) or cited from a primary source.
            </p>
          </div>
        </div>
        <a
          href="https://www.swebench.com"
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-lg border border-graphite-600 bg-graphite-850 px-4 py-2 text-sm font-medium text-graphite-100 hover:border-ember/60"
        >
          Live official leaderboard ↗
        </a>
      </header>

      <TrustBanner allSample={allSample} />
      <ResolvedRateChart rows={rows} />
      <ResultsTable rows={rows} />
      <HowItWorks />
      <Methodology />
      <ThirdPartyPanel />
      <SourcesList />

      <footer className="mt-4 text-center text-xs text-graphite-600">
        Launch with{" "}
        <code className="rounded bg-graphite-850 px-1.5 py-0.5 text-graphite-400">pnpm eval:app</code>.
        No simulated benchmark scores appear anywhere on this page.
      </footer>
    </main>
  );
}
