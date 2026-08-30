/**
 * Eval harness — runs golden traces through the context compiler and
 * measures quality metrics. Used as a CI regression gate.
 */
import type { EvalMetrics } from "./metrics";
import type { GoldenTrace, TurnValidation } from "./golden-traces";
import { validateTurn } from "./golden-traces";
import { detectRegressions, type MetricRegression } from "./metrics";

export interface EvalRunResult {
  traceId: string;
  traceName: string;
  turnResults: TurnValidation[];
  metrics: EvalMetrics;
  regressions: MetricRegression[];
  passed: boolean;
}

export interface EvalSuiteResult {
  totalTraces: number;
  passed: number;
  failed: number;
  results: EvalRunResult[];
  overallPassed: boolean;
}

/**
 * Run the eval harness against a set of golden traces.
 *
 * For each trace:
 * 1. Replay each turn's task frame through compile()
 * 2. Check that required records are in the window
 * 3. Check that forbidden records are NOT in the window
 * 4. Compute metrics and compare against baseline
 */
export async function runEvalSuite(
  traces: GoldenTrace[],
  compileFn: (
    taskFrame: GoldenTrace["turns"][0]["taskFrame"],
    budget: GoldenTrace["turns"][0]["budget"],
  ) => Promise<string[]>,
): Promise<EvalSuiteResult> {
  const results: EvalRunResult[] = [];

  for (const trace of traces) {
    const turnResults: TurnValidation[] = [];
    let totalCompileMs = 0;
    let hitCount = 0;
    let totalRetrieval = 0;

    for (const turn of trace.turns) {
      const startMs = Date.now();
      const packedIds = await compileFn(turn.taskFrame, turn.budget);
      totalCompileMs += Date.now() - startMs;

      const validation = validateTurn(packedIds, turn);
      turnResults.push(validation);

      // Track retrieval hit rate
      totalRetrieval++;
      if (validation.missingRequired.length === 0) hitCount++;
    }

    // Compute metrics for this trace.
    //
    // Only the three retrieval-quality metrics are measured. `tokensToSuccess`,
    // `cacheHitRate` and `costPerTask` are reported as 0 because compileFn
    // returns record ids only — it carries no token, cache, or cost signal —
    // and `detectRegressions` skips any metric whose baseline is 0, so those
    // three are NOT gated. `turnLatency` is a coarse wall-clock summary, not
    // true percentiles: with one sample per turn there is nothing to rank, so
    // p50 is the mean and p95/p99 repeat the trace total.
    const measuredTurns = Math.max(1, turnResults.length);
    const metrics: EvalMetrics = {
      contextPrecision:
        turnResults.reduce((s, t) => s + t.precision, 0) / measuredTurns,
      contextRecall: hitCount / Math.max(1, totalRetrieval),
      tokensToSuccess: 0,
      retrievalHitRate: hitCount / Math.max(1, totalRetrieval),
      cacheHitRate: 0,
      turnLatency: {
        p50: totalCompileMs / measuredTurns,
        p95: totalCompileMs,
        p99: totalCompileMs,
      },
      costPerTask: 0,
    };

    const regressions = detectRegressions(metrics, trace.baseline);
    const passed = regressions.length === 0 && turnResults.every((t) => t.pass);

    results.push({
      traceId: trace.id,
      traceName: trace.name,
      turnResults,
      metrics,
      regressions,
      passed,
    });
  }

  return {
    totalTraces: traces.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
    overallPassed: results.every((r) => r.passed),
  };
}
