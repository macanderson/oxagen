/**
 * Tests for eval/metrics.ts — detectRegressions and DEFAULT_THRESHOLDS.
 */
import { describe, it, expect } from "vitest";
import {
  detectRegressions,
  DEFAULT_THRESHOLDS,
  type EvalMetrics,
  type MetricThresholds,
} from "./metrics";

const perfectMetrics: EvalMetrics = {
  contextPrecision: 1.0,
  contextRecall: 1.0,
  tokensToSuccess: 1000,
  retrievalHitRate: 1.0,
  cacheHitRate: 0.9,
  turnLatency: { p50: 100, p95: 200, p99: 300 },
  costPerTask: 0.01,
};

describe("DEFAULT_THRESHOLDS", () => {
  it("has expected keys and sensible values", () => {
    expect(DEFAULT_THRESHOLDS.contextPrecision).toBe(0.05);
    expect(DEFAULT_THRESHOLDS.contextRecall).toBe(0.05);
    expect(DEFAULT_THRESHOLDS.tokensToSuccess).toBe(0.1);
    expect(DEFAULT_THRESHOLDS.retrievalHitRate).toBe(0.05);
    expect(DEFAULT_THRESHOLDS.cacheHitRate).toBe(0.1);
    expect(DEFAULT_THRESHOLDS.costPerTask).toBe(0.15);
  });
});

describe("detectRegressions", () => {
  it("returns no regressions when current matches baseline", () => {
    const regressions = detectRegressions(perfectMetrics, perfectMetrics);
    expect(regressions).toHaveLength(0);
  });

  it("detects contextPrecision regression beyond threshold", () => {
    const current: EvalMetrics = {
      ...perfectMetrics,
      contextPrecision: 0.9, // degraded from 1.0 by 10%, threshold is 5%
    };
    const regressions = detectRegressions(current, perfectMetrics);
    const hit = regressions.find((r) => r.metric === "contextPrecision");
    expect(hit).toBeDefined();
    expect(hit!.degradation).toBeCloseTo(0.1, 5);
    expect(hit!.baseline).toBe(1.0);
    expect(hit!.current).toBe(0.9);
  });

  it("does not flag contextPrecision that is within threshold", () => {
    const current: EvalMetrics = {
      ...perfectMetrics,
      contextPrecision: 0.97, // only 3% degradation, threshold is 5%
    };
    const regressions = detectRegressions(current, perfectMetrics);
    expect(
      regressions.find((r) => r.metric === "contextPrecision"),
    ).toBeUndefined();
  });

  it("detects contextRecall regression", () => {
    const current: EvalMetrics = { ...perfectMetrics, contextRecall: 0.8 };
    const regressions = detectRegressions(current, perfectMetrics);
    expect(regressions.find((r) => r.metric === "contextRecall")).toBeDefined();
  });

  it("detects retrievalHitRate regression", () => {
    const current: EvalMetrics = { ...perfectMetrics, retrievalHitRate: 0.9 };
    const regressions = detectRegressions(current, perfectMetrics);
    expect(
      regressions.find((r) => r.metric === "retrievalHitRate"),
    ).toBeDefined();
  });

  it("detects cacheHitRate regression", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, cacheHitRate: 0.8 };
    const current: EvalMetrics = { ...perfectMetrics, cacheHitRate: 0.5 }; // 37.5% drop
    const regressions = detectRegressions(current, baseline);
    expect(regressions.find((r) => r.metric === "cacheHitRate")).toBeDefined();
  });

  it("detects tokensToSuccess inflation", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 1000 };
    const current: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 1500 }; // 50% more
    const regressions = detectRegressions(current, baseline);
    const hit = regressions.find((r) => r.metric === "tokensToSuccess");
    expect(hit).toBeDefined();
    expect(hit!.degradation).toBeCloseTo(0.5, 5);
  });

  it("does not flag tokensToSuccess within threshold", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 1000 };
    const current: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 1050 }; // 5% more
    const regressions = detectRegressions(current, baseline);
    expect(
      regressions.find((r) => r.metric === "tokensToSuccess"),
    ).toBeUndefined();
  });

  it("detects costPerTask inflation", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, costPerTask: 0.01 };
    const current: EvalMetrics = { ...perfectMetrics, costPerTask: 0.02 }; // 100% more
    const regressions = detectRegressions(current, baseline);
    expect(regressions.find((r) => r.metric === "costPerTask")).toBeDefined();
  });

  it("skips higher-is-better metrics when baseline is 0", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, contextPrecision: 0 };
    const current: EvalMetrics = { ...perfectMetrics, contextPrecision: 0 };
    const regressions = detectRegressions(current, baseline);
    expect(
      regressions.find((r) => r.metric === "contextPrecision"),
    ).toBeUndefined();
  });

  it("skips lower-is-better metrics when baseline is 0", () => {
    const baseline: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 0 };
    const current: EvalMetrics = { ...perfectMetrics, tokensToSuccess: 1000 };
    const regressions = detectRegressions(current, baseline);
    expect(
      regressions.find((r) => r.metric === "tokensToSuccess"),
    ).toBeUndefined();
  });

  it("uses custom thresholds when provided", () => {
    const strictThresholds: MetricThresholds = { contextPrecision: 0.001 };
    const baseline: EvalMetrics = { ...perfectMetrics, contextPrecision: 0.99 };
    const current: EvalMetrics = { ...perfectMetrics, contextPrecision: 0.98 };
    // 1% drop exceeds 0.1% threshold
    const regressions = detectRegressions(current, baseline, strictThresholds);
    expect(
      regressions.find((r) => r.metric === "contextPrecision"),
    ).toBeDefined();
  });

  it("returns multiple regressions when multiple metrics fail", () => {
    const current: EvalMetrics = {
      ...perfectMetrics,
      contextPrecision: 0.8, // 20% drop
      contextRecall: 0.8, // 20% drop
      retrievalHitRate: 0.8, // 20% drop
    };
    const regressions = detectRegressions(current, perfectMetrics);
    expect(regressions.length).toBeGreaterThanOrEqual(3);
  });
});
