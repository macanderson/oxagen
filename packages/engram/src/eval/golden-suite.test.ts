/**
 * Golden suite gate — turns the eval harness into a real CI regression gate.
 *
 * This runs `runEvalSuite` over the instantiated fixtures + deterministic compiler
 * and asserts the context engine still retrieves the right records and rejects
 * domain noise. If a change degrades retrieval below the baseline in
 * golden-fixtures.ts, this test fails (via `detectRegressions`) — which is the whole
 * point of a context-quality gate.
 */
import { describe, it, expect } from "vitest";
import { runGoldenSuite, buildRagDataset } from "./run-golden";
import {
  GOLDEN_CORPUS,
  GOLDEN_TRACES,
  GOLDEN_GROUND_TRUTH,
} from "./golden-fixtures";
import { makeGoldenCompileFn } from "./golden-compile";

describe("engram golden eval suite", () => {
  it("passes the full suite with no regressions vs baseline", async () => {
    const result = await runGoldenSuite();
    expect(result.overallPassed).toBe(true);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(GOLDEN_TRACES.length);
    for (const trace of result.results) {
      expect(trace.regressions).toEqual([]);
      expect(trace.passed).toBe(true);
    }
  });

  it("meets or beats the baseline on context precision, recall, and hit rate", async () => {
    const result = await runGoldenSuite();
    for (const trace of result.results) {
      const baseline = GOLDEN_TRACES.find((t) => t.id === trace.traceId)!.baseline;
      expect(trace.metrics.contextPrecision).toBeGreaterThanOrEqual(baseline.contextPrecision);
      expect(trace.metrics.contextRecall).toBeGreaterThanOrEqual(baseline.contextRecall);
      expect(trace.metrics.retrievalHitRate).toBeGreaterThanOrEqual(baseline.retrievalHitRate);
    }
  });

  it("retrieves every required record and excludes every forbidden one, per turn", async () => {
    const compile = makeGoldenCompileFn(GOLDEN_CORPUS);
    for (const trace of GOLDEN_TRACES) {
      for (const turn of trace.turns) {
        const packed = new Set(await compile(turn.taskFrame, turn.budget));
        for (const required of turn.requiredInContext) expect(packed.has(required)).toBe(true);
        for (const forbidden of turn.forbiddenInContext) expect(packed.has(forbidden)).toBe(false);
      }
    }
  });

  it("never packs a trace's excluded (noise) records", async () => {
    const compile = makeGoldenCompileFn(GOLDEN_CORPUS);
    for (const trace of GOLDEN_TRACES) {
      const excluded = new Set(trace.excludedRecords);
      for (const turn of trace.turns) {
        const packed = await compile(turn.taskFrame, turn.budget);
        expect(packed.filter((id) => excluded.has(id))).toEqual([]);
      }
    }
  });

  it("exports a RAGAS/DeepEval dataset in the bench/rag-eval schema", async () => {
    const rows = await buildRagDataset();
    const totalTurns = GOLDEN_TRACES.reduce((n, t) => n + t.turns.length, 0);
    expect(rows.length).toBe(totalTurns);
    for (const row of rows) {
      expect(row.id).toBeTruthy();
      expect(row.question).toBeTruthy();
      expect(Array.isArray(row.contexts)).toBe(true);
      expect(row.contexts.length).toBeGreaterThan(0);
      expect(row.ground_truth).toBeTruthy();
      expect(row.answer).toBe(row.ground_truth);
      // ground truth answers come from the fixture's known-good map
      expect(Object.values(GOLDEN_GROUND_TRUTH)).toContain(row.ground_truth);
    }
  });
});
