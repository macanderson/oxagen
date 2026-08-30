/**
 * Eval metrics — defines what we measure to assess context quality.
 */

export interface EvalMetrics {
  /** Of what was packed, how much did the model actually use? */
  contextPrecision: number;
  /** Of what the model needed, how much was present in the window? */
  contextRecall: number;
  /** Total tokens consumed to complete the task. */
  tokensToSuccess: number;
  /** % of retrieval queries that returned useful results. */
  retrievalHitRate: number;
  /** Prompt cache hit rate. */
  cacheHitRate: number;
  /** Turn latency percentiles in ms. */
  turnLatency: { p50: number; p95: number; p99: number };
  /** USD cost for task completion. */
  costPerTask: number;
}

export interface MetricThresholds {
  /** Max allowed regression per metric (e.g., 0.05 = 5% degradation). */
  [metricName: string]: number;
}

export const DEFAULT_THRESHOLDS: MetricThresholds = {
  contextPrecision: 0.05,
  contextRecall: 0.05,
  tokensToSuccess: 0.1, // 10% more tokens is acceptable
  retrievalHitRate: 0.05,
  cacheHitRate: 0.1,
  costPerTask: 0.15,
};

/**
 * Compare current metrics against a baseline.
 * Returns which metrics regressed beyond threshold.
 */
export function detectRegressions(
  current: EvalMetrics,
  baseline: EvalMetrics,
  thresholds: MetricThresholds = DEFAULT_THRESHOLDS,
): MetricRegression[] {
  const regressions: MetricRegression[] = [];

  // Higher is better for these metrics
  const higherIsBetter = [
    "contextPrecision",
    "contextRecall",
    "retrievalHitRate",
    "cacheHitRate",
  ] as const;
  for (const metric of higherIsBetter) {
    const baselineVal = baseline[metric];
    const currentVal = current[metric];
    if (baselineVal > 0) {
      const degradation = (baselineVal - currentVal) / baselineVal;
      if (degradation > (thresholds[metric] ?? 0.05)) {
        regressions.push({
          metric,
          baseline: baselineVal,
          current: currentVal,
          degradation,
        });
      }
    }
  }

  // Lower is better for these metrics
  const lowerIsBetter = ["tokensToSuccess", "costPerTask"] as const;
  for (const metric of lowerIsBetter) {
    const baselineVal = baseline[metric];
    const currentVal = current[metric];
    if (baselineVal > 0) {
      const inflation = (currentVal - baselineVal) / baselineVal;
      if (inflation > (thresholds[metric] ?? 0.1)) {
        regressions.push({
          metric,
          baseline: baselineVal,
          current: currentVal,
          degradation: inflation,
        });
      }
    }
  }

  return regressions;
}

export interface MetricRegression {
  metric: string;
  baseline: number;
  current: number;
  degradation: number;
}
