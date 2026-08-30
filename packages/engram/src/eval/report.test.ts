/**
 * Tests for eval/report.ts — generateTextReport and generateJsonReport.
 */
import { describe, it, expect } from "vitest";
import { generateTextReport, generateJsonReport } from "./report";
import type { EvalSuiteResult } from "./harness";
import type { EvalMetrics } from "./metrics";

const metrics: EvalMetrics = {
  contextPrecision: 0.85,
  contextRecall: 0.9,
  tokensToSuccess: 1200,
  retrievalHitRate: 0.8,
  cacheHitRate: 0.7,
  turnLatency: { p50: 100, p95: 200, p99: 300 },
  costPerTask: 0.02,
};

function makeResult(overrides: Partial<EvalSuiteResult> = {}): EvalSuiteResult {
  return {
    totalTraces: 2,
    passed: 1,
    failed: 1,
    overallPassed: false,
    results: [
      {
        traceId: "trace-001",
        traceName: "Auth flow test",
        metrics,
        regressions: [],
        turnResults: [
          {
            pass: true,
            precision: 1.0,
            missingRequired: [],
            includedForbidden: [],
          },
        ],
        passed: true,
      },
      {
        traceId: "trace-002",
        traceName: "DB query test",
        metrics,
        regressions: [
          {
            metric: "contextPrecision",
            baseline: 0.9,
            current: 0.7,
            degradation: 0.22,
          },
        ],
        turnResults: [
          {
            pass: true,
            precision: 0.8,
            missingRequired: [],
            includedForbidden: [],
          },
          {
            pass: false,
            precision: 0.5,
            missingRequired: ["rec-1"],
            includedForbidden: [],
          },
        ],
        passed: false,
      },
    ],
    ...overrides,
  };
}

describe("generateTextReport", () => {
  it("includes header lines", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("OXAGEN EVAL REPORT");
  });

  it("includes trace counts", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("Traces: 2");
    expect(report).toContain("Passed: 1");
    expect(report).toContain("Failed: 1");
  });

  it("shows FAIL for failed suite", () => {
    const report = generateTextReport(makeResult({ overallPassed: false }));
    expect(report).toContain("✗ FAIL");
  });

  it("shows PASS for passed suite", () => {
    const passed: EvalSuiteResult = makeResult({
      overallPassed: true,
      failed: 0,
      passed: 2,
    });
    const report = generateTextReport(passed);
    expect(report).toContain("✓ PASS");
  });

  it("includes trace names", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("Auth flow test");
    expect(report).toContain("DB query test");
  });

  it("includes precision and recall", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("Precision:");
    expect(report).toContain("Recall:");
    expect(report).toContain("85.0%");
    expect(report).toContain("90.0%");
  });

  it("includes regression warnings", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("contextPrecision");
    expect(report).toContain("regression");
  });

  it("includes failed turn count when turns fail", () => {
    const report = generateTextReport(makeResult());
    expect(report).toContain("turn(s) failed validation");
  });

  it("does not show regression section for passing trace", () => {
    const passingOnly: EvalSuiteResult = {
      ...makeResult(),
      results: [makeResult().results[0]!],
    };
    const report = generateTextReport(passingOnly);
    expect(report).not.toContain("regression");
  });

  it("produces non-empty output", () => {
    const report = generateTextReport(makeResult());
    expect(report.length).toBeGreaterThan(50);
  });
});

describe("generateJsonReport", () => {
  it("produces valid JSON", () => {
    const json = generateJsonReport(makeResult());
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("includes top-level fields", () => {
    const json = generateJsonReport(makeResult());
    const parsed = JSON.parse(json) as {
      passed: boolean;
      totalTraces: number;
      passedTraces: number;
      failedTraces: number;
      traces: unknown[];
    };
    expect(parsed.passed).toBe(false);
    expect(parsed.totalTraces).toBe(2);
    expect(parsed.passedTraces).toBe(1);
    expect(parsed.failedTraces).toBe(1);
  });

  it("includes trace details", () => {
    const json = generateJsonReport(makeResult());
    const parsed = JSON.parse(json) as {
      traces: Array<{
        id: string;
        name: string;
        passed: boolean;
        metrics: EvalMetrics;
        regressions: unknown[];
      }>;
    };
    expect(parsed.traces).toHaveLength(2);
    expect(parsed.traces[0]!.id).toBe("trace-001");
    expect(parsed.traces[0]!.name).toBe("Auth flow test");
    expect(parsed.traces[0]!.passed).toBe(true);
    expect(parsed.traces[1]!.regressions).toHaveLength(1);
  });

  it("is pretty-printed with 2-space indent", () => {
    const json = generateJsonReport(makeResult());
    expect(json).toContain("\n  ");
  });

  it("handles empty results array", () => {
    const empty: EvalSuiteResult = {
      totalTraces: 0,
      passed: 0,
      failed: 0,
      overallPassed: true,
      results: [],
    };
    const json = generateJsonReport(empty);
    const parsed = JSON.parse(json) as { traces: unknown[] };
    expect(parsed.traces).toHaveLength(0);
  });
});
