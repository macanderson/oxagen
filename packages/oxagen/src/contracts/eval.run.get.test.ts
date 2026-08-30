import { describe, expect, it } from "vitest";
import { evalRunGet } from "./eval.run.get";
import { getCapability } from "../registry";

const VALID_RUN = {
  runId: "run_1",
  datasetId: "ds_1",
  name: "Weekly regression",
  target: { kind: "model" as const },
  judgeModel: "anthropic/claude-sonnet-5",
  passThreshold: 0.7,
  status: "completed" as const,
  itemCount: 10,
  completedCount: 10,
  failedCount: 0,
  avgScore: 0.91,
  scoreBreakdown: { correctness: 0.9, faithfulness: 0.92 },
  createdAt: "2026-07-01T00:00:00.000Z",
};

const VALID_RESULT = {
  itemId: "item_1",
  targetKind: "model",
  model: "anthropic/claude-sonnet-5",
  judgeModel: "anthropic/claude-sonnet-5",
  score: 0.9,
  correctness: 0.9,
  faithfulness: 0.9,
  passed: true,
  latencyMs: 1200,
  inputTokens: 100,
  outputTokens: 50,
  costUsdMicros: 500,
  status: "completed" as const,
  errorClass: "",
  output: "The refund window is 30 days.",
  rationale: "Matches the expected answer closely.",
};

describe("eval.run.get capability", () => {
  it("parses a valid input", () => {
    const parsed = evalRunGet.input.parse({ runPublicId: "run_pub_1" });
    expect(parsed.runPublicId).toBe("run_pub_1");
  });

  it("rejects a missing runPublicId", () => {
    expect(() => evalRunGet.input.parse({})).toThrow();
  });

  it("parses a valid output with results", () => {
    const out = evalRunGet.output.parse({
      run: VALID_RUN,
      results: [VALID_RESULT],
    });
    expect(out.run.status).toBe("completed");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.passed).toBe(true);
  });

  it("parses a valid output with zero results", () => {
    const out = evalRunGet.output.parse({
      run: {
        ...VALID_RUN,
        status: "pending",
        completedCount: 0,
        avgScore: null,
      },
      results: [],
    });
    expect(out.results).toHaveLength(0);
  });

  it("rejects an output with an invalid result status", () => {
    expect(() =>
      evalRunGet.output.parse({
        run: VALID_RUN,
        results: [{ ...VALID_RESULT, status: "errored" }],
      }),
    ).toThrow();
  });

  it("rejects an output missing the run.target field", () => {
    const { target, ...runWithoutTarget } = VALID_RUN;
    expect(() =>
      evalRunGet.output.parse({
        run: runWithoutTarget,
        results: [],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_eval_run")).toBe(evalRunGet);
  });
});
