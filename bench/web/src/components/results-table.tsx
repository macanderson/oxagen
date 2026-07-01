// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed — the useState below rides the boundary
// already opened by the parent.
import { Fragment, useState } from "react";
import { Card, SectionTitle } from "@/components/atoms";
import { cn, formatPercent1, formatTokens, formatUsd } from "@/lib/format";
import type { AgentSummaryRow } from "@/lib/types";

function ProvenanceBadge({ row }: { readonly row: AgentSummaryRow }): React.ReactElement {
  if (row.provenance.kind === "sample") {
    return (
      <span className="rounded-md border border-amber-500/50 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-300">
        Sample
      </span>
    );
  }
  if (row.provenance.kind === "reference") {
    return (
      <span className="rounded-md border border-graphite-600 bg-graphite-850 px-2 py-0.5 text-xs font-semibold text-graphite-300">
        Reference
      </span>
    );
  }
  return (
    <span className="rounded-md border border-ember/50 bg-ember/15 px-2 py-0.5 text-xs font-semibold text-ember">
      Measured
    </span>
  );
}

function RowDetail({ row }: { readonly row: AgentSummaryRow }): React.ReactElement {
  const { provenance } = row;
  if (provenance.kind === "sample") {
    return (
      <p className="text-sm text-amber-200/80">
        This row is SAMPLE DATA — illustrative only, not a real benchmark run. It carries no reproduce
        command because there is nothing to reproduce.
      </p>
    );
  }
  if (provenance.kind === "reference") {
    return (
      <p className="text-sm text-graphite-300">
        Cited from{" "}
        <a
          href={provenance.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-ember underline underline-offset-2"
        >
          {provenance.source}
        </a>{" "}
        (published {provenance.published || "date unknown"}).
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      <div>
        <dt className="text-xs uppercase tracking-wide text-graphite-400">Harness</dt>
        <dd className="text-graphite-200">{provenance.harness}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-graphite-400">Run date</dt>
        <dd className="text-graphite-200">{provenance.runDate || "—"}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-graphite-400">Git SHA</dt>
        <dd className="font-mono text-graphite-200">{provenance.gitSha || "—"}</dd>
      </div>
      <div className="col-span-2 sm:col-span-4">
        <dt className="text-xs uppercase tracking-wide text-graphite-400">Reproduce</dt>
        <dd>
          <code className="mt-0.5 block w-fit rounded bg-graphite-950/70 px-2 py-1 font-mono text-xs text-graphite-200">
            {provenance.reproduce}
          </code>
        </dd>
      </div>
      <p className="col-span-2 text-xs text-graphite-400 sm:col-span-4">
        Self-reported — not yet third-party checkmarked on swebench.com.
      </p>
    </dl>
  );
}

/**
 * Renders the real per-run results loaded from `results-data/`, ranked by
 * resolved rate. Sample rows get an unmistakable amber badge and a caption
 * calling them out; rows sharing dataset + model are annotated as a
 * controlled head-to-head so an apples-to-apples comparison is explicit.
 */
export function ResultsTable({ rows }: { readonly rows: readonly AgentSummaryRow[] }): React.ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const hasSample = rows.some((r) => r.provenance.kind === "sample");

  return (
    <Card>
      <SectionTitle title="Results" hint="sorted by resolved rate" />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-graphite-700 text-xs uppercase tracking-wide text-graphite-400">
              <th className="px-3 py-2 font-medium">Agent</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Dataset</th>
              <th className="px-3 py-2 text-right font-medium">Resolved</th>
              <th className="px-3 py-2 text-right font-medium">Passed / total</th>
              <th className="px-3 py-2 text-right font-medium">Avg cost</th>
              <th className="px-3 py-2 text-right font-medium">Avg tokens</th>
              <th className="px-3 py-2 font-medium">Provenance</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = expanded === row.runId;
              return (
                <Fragment key={row.runId}>
                  <tr
                    className={cn(
                      "border-b border-graphite-800/70 last:border-0",
                      row.provenance.kind === "sample" && "bg-amber-500/5",
                    )}
                  >
                    <td className="px-3 py-2 font-medium text-graphite-100">{row.agentName}</td>
                    <td className="px-3 py-2 text-graphite-300">{row.model}</td>
                    <td className="px-3 py-2 text-graphite-300">
                      {row.dataset}
                      {row.controlledGroupKey ? (
                        <span
                          title="Controlled head-to-head: same dataset + same base model"
                          className="ml-2 rounded bg-graphite-850 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-graphite-400"
                        >
                          Controlled
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-graphite-100">
                      {formatPercent1(row.resolvedRate)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                      {row.nPassed} / {row.nTasks}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                      {row.avgCostUsd === null ? "—" : formatUsd(row.avgCostUsd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                      {row.avgTokens === null ? "—" : formatTokens(row.avgTokens)}
                    </td>
                    <td className="px-3 py-2">
                      <ProvenanceBadge row={row} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : row.runId)}
                        aria-expanded={isOpen}
                        className="text-xs font-medium text-graphite-400 underline-offset-2 hover:text-graphite-100 hover:underline"
                      >
                        {isOpen ? "Hide" : "Details"}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-graphite-800/70 last:border-0">
                      <td colSpan={9} className="bg-graphite-850/60 px-3 py-3">
                        <RowDetail row={row} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasSample ? (
        <p className="mt-3 text-xs text-amber-300/80">
          Rows badged &ldquo;Sample&rdquo; are illustrative only and are not real benchmark runs.
        </p>
      ) : null}
    </Card>
  );
}
