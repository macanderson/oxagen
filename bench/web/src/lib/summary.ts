import type { AgentSummaryRow, EvalResult, EvalRun, EvalRunMeta, Provenance } from "./types";

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function averageMetric(results: readonly EvalResult[], pick: (r: EvalResult) => number): number | null {
  return average(results.map(pick));
}

/**
 * Derive a run's provenance from its labels. `labels.provenance === "sample"`
 * is the ONLY way a run renders as SAMPLE — every other run is treated as a
 * real MEASURED result and must carry a reproduce command, defaulting to the
 * standard harness invocation when the file doesn't set one explicitly.
 */
export function deriveProvenance(run: EvalRunMeta): Provenance {
  if (run.labels.provenance === "sample") {
    return { kind: "sample" };
  }
  return {
    kind: "measured",
    harness: run.harness,
    dataset: run.suite,
    model: run.model,
    runDate: run.labels.run_date ?? "",
    gitSha: run.git_sha,
    reproduce:
      run.labels.reproduce ?? `pnpm bench:swe:compare --suite ${run.suite} --agent ${run.agent_name}`,
  };
}

/** `run_id::dataset::model` — the key used to detect a controlled head-to-head. */
function groupKey(run: EvalRunMeta): string {
  return `${run.suite}::${run.model}`;
}

/**
 * Turn real eval runs into ranked summary rows. Pure arithmetic only — no
 * invented multipliers, no baseline assumptions, no numbers not present in the
 * source documents. Sorted by resolved rate descending; ties break on agent
 * name for a stable, deterministic order.
 */
export function summarizeRuns(runs: readonly EvalRun[]): AgentSummaryRow[] {
  if (runs.length === 0) return [];

  const keyCounts = new Map<string, number>();
  for (const { run } of runs) {
    const key = groupKey(run);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const rows = runs.map(({ run, results }): AgentSummaryRow => {
    const key = groupKey(run);
    const resolvedRate = run.n_tasks > 0 ? run.n_passed / run.n_tasks : 0;
    return {
      runId: run.run_id,
      agentName: run.agent_name,
      model: run.model,
      dataset: run.suite,
      resolvedRate,
      nPassed: run.n_passed,
      nTasks: run.n_tasks,
      avgCostUsd: averageMetric(results, (r) => r.metrics.cost_usd),
      avgTokens: averageMetric(results, (r) => r.metrics.tokens),
      avgWallS: averageMetric(results, (r) => r.metrics.wall_s),
      provenance: deriveProvenance(run),
      controlledGroupKey: (keyCounts.get(key) ?? 0) >= 2 ? key : null,
    };
  });

  return [...rows].sort(
    (a, b) => b.resolvedRate - a.resolvedRate || a.agentName.localeCompare(b.agentName),
  );
}
