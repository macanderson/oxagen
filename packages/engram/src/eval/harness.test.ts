/**
 * Tests for eval/harness.ts — runEvalSuite.
 */
import { describe, it, expect, vi } from "vitest";
import { runEvalSuite } from "./harness";
import type { GoldenTrace } from "./golden-traces";
import type { TaskFrame } from "../retrieval/types";
import type { TokenBudget } from "../compiler/packer";
import type { EvalMetrics } from "./metrics";

const taskFrame: TaskFrame = {
  namespace: { org: "org", workspace: "ws" },
  taskDescription: "task",
  workingSet: [],
  recentEventIds: [],
  modelId: "gpt-4",
};

const budget: TokenBudget = {
  total: 128000,
  reserved: { system: 500, procedural: 1000, volatile: 125000, working: 1500 },
};

// NOTE: the harness hardcodes cacheHitRate: 0 and tokensToSuccess: 0 in the computed metrics,
// so baselines for those should be 0 to avoid false regressions in tests.
const baselineMetrics: EvalMetrics = {
  contextPrecision: 0.8,
  contextRecall: 0.8,
  tokensToSuccess: 0,
  retrievalHitRate: 0.8,
  cacheHitRate: 0,
  turnLatency: { p50: 100, p95: 200, p99: 300 },
  costPerTask: 0,
};

function makeTrace(overrides: Partial<GoldenTrace> = {}): GoldenTrace {
  return {
    id: "trace-1",
    name: "Test trace",
    description: "A test golden trace",
    turns: [
      {
        taskFrame,
        budget,
        requiredInContext: ["rec-1"],
        forbiddenInContext: [],
        expectedToolCalls: [],
        expectedOutcome: "success",
      },
    ],
    expectedRecords: ["rec-1"],
    excludedRecords: [],
    baseline: baselineMetrics,
    lastValidated: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("runEvalSuite", () => {
  it("returns correct counts for a single passing trace", async () => {
    const trace = makeTrace();
    // compileFn returns the required record — passes validation
    const compileFn = vi.fn(async () => ["rec-1", "extra-1"]);

    const result = await runEvalSuite([trace], compileFn);

    expect(result.totalTraces).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.overallPassed).toBe(true);
  });

  it("returns correct counts for a failing trace (missing required)", async () => {
    const trace = makeTrace();
    // compileFn does NOT return the required record
    const compileFn = vi.fn(async () => ["wrong-record"]);

    const result = await runEvalSuite([trace], compileFn);

    expect(result.totalTraces).toBe(1);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.overallPassed).toBe(false);
  });

  it("runs compileFn for each turn", async () => {
    const trace = makeTrace({
      turns: [
        {
          taskFrame,
          budget,
          requiredInContext: ["r1"],
          forbiddenInContext: [],
          expectedToolCalls: [],
          expectedOutcome: "success",
        },
        {
          taskFrame,
          budget,
          requiredInContext: ["r2"],
          forbiddenInContext: [],
          expectedToolCalls: [],
          expectedOutcome: "success",
        },
      ],
    });
    const compileFn = vi.fn(async () => ["r1", "r2"]);

    await runEvalSuite([trace], compileFn);

    expect(compileFn).toHaveBeenCalledTimes(2);
  });

  it("handles empty traces array", async () => {
    const compileFn = vi.fn(async () => []);
    const result = await runEvalSuite([], compileFn);

    expect(result.totalTraces).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.overallPassed).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it("computes metrics for each trace result", async () => {
    const trace = makeTrace();
    const compileFn = vi.fn(async () => ["rec-1"]);

    const result = await runEvalSuite([trace], compileFn);

    const traceResult = result.results[0]!;
    expect(traceResult.traceId).toBe("trace-1");
    expect(traceResult.traceName).toBe("Test trace");
    expect(traceResult.metrics.contextPrecision).toBeGreaterThanOrEqual(0);
    expect(traceResult.metrics.contextRecall).toBeGreaterThanOrEqual(0);
    expect(traceResult.metrics.retrievalHitRate).toBeGreaterThanOrEqual(0);
    expect(traceResult.turnResults).toHaveLength(1);
  });

  it("detects regressions when metrics exceed thresholds", async () => {
    // Baseline has high contextPrecision (0.99)
    // The compileFn returns records so required are satisfied (precision=1.0), but
    // we need to simulate lower precision — use a trace where required is partially missing
    const trace = makeTrace({
      turns: [
        {
          taskFrame,
          budget,
          // 4 required, only 1 returned → precision = 0.25
          requiredInContext: ["r1", "r2", "r3", "r4"],
          forbiddenInContext: [],
          expectedToolCalls: [],
          expectedOutcome: "success",
        },
      ],
      baseline: {
        ...baselineMetrics,
        contextPrecision: 0.99, // very high baseline
      },
    });
    const compileFn = vi.fn(async () => ["r1"]); // only 1 of 4

    const result = await runEvalSuite([trace], compileFn);

    // Precision = 0.25, baseline = 0.99 → big regression
    const traceResult = result.results[0]!;
    expect(traceResult.regressions.length).toBeGreaterThan(0);
    expect(traceResult.passed).toBe(false);
  });

  it("handles multiple traces correctly", async () => {
    const trace1 = makeTrace({ id: "t1", name: "Trace 1" });
    const trace2 = makeTrace({ id: "t2", name: "Trace 2" });
    const compileFn = vi.fn(async () => ["rec-1"]);

    const result = await runEvalSuite([trace1, trace2], compileFn);

    expect(result.totalTraces).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.traceId).toBe("t1");
    expect(result.results[1]!.traceId).toBe("t2");
  });

  it("passes the correct taskFrame and budget to compileFn", async () => {
    const trace = makeTrace();
    const compileFn = vi.fn(async (_frame: TaskFrame, _bud: TokenBudget) => [
      "rec-1",
    ]);

    await runEvalSuite([trace], compileFn);

    expect(compileFn).toHaveBeenCalledWith(
      trace.turns[0]!.taskFrame,
      trace.turns[0]!.budget,
    );
  });
});
