import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  selectEvalItemResults: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/telemetry", () => ({
  selectEvalItemResults: mocks.selectEvalItemResults,
}));

import { evalRunGetHandler } from "./eval.run.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

type TxLike = { select: ReturnType<typeof vi.fn> };

function makeTx(rows: unknown[]): TxLike {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    }),
  };
}

const NOW = new Date("2026-01-01T00:00:00Z");
const RUN_ROW = {
  publicId: "evr_ABC",
  datasetPublicId: "eds_ABC",
  name: "Nightly run",
  target: { kind: "model", model: "gateway/balanced" },
  judgeModel: "gateway/precise-model",
  passThreshold: "0.7",
  status: "completed",
  itemCount: 2,
  completedCount: 2,
  failedCount: 0,
  avgScore: "0.91",
  scoreBreakdown: { correctness: 0.9, faithfulness: 0.92 },
  createdAt: NOW,
  workspaceId: CTX.workspaceId,
};

// Snake_case rows exactly as ClickHouse's EvalItemResultRow shape returns them.
const ITEM_ROW_PASSED = {
  run_id: "uuid-run-1",
  dataset_id: "uuid-dataset-1",
  item_id: "edi_1",
  target_kind: "model",
  model: "gateway/balanced",
  judge_model: "gateway/precise-model",
  score: 0.95,
  correctness: 0.96,
  faithfulness: 0.94,
  passed: 1,
  latency_ms: 812,
  input_tokens: 120,
  output_tokens: 48,
  cost_usd_micros: 340,
  status: "completed",
  error_class: "",
  output: "The answer is 4.",
  rationale: "Matches expected output.",
};

const ITEM_ROW_FAILED = {
  ...ITEM_ROW_PASSED,
  item_id: "edi_2",
  passed: 0,
  score: 0.2,
  status: "completed",
};

describe("eval.run.get handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the run summary and maps snake_case item results to camelCase booleans", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([RUN_ROW])),
    );
    mocks.selectEvalItemResults.mockResolvedValue([
      ITEM_ROW_PASSED,
      ITEM_ROW_FAILED,
    ]);

    const out = await evalRunGetHandler({ runPublicId: "evr_ABC" }, CTX);

    expect(out.run).toEqual({
      runId: "evr_ABC",
      datasetId: "eds_ABC",
      name: "Nightly run",
      target: { kind: "model", model: "gateway/balanced" },
      judgeModel: "gateway/precise-model",
      passThreshold: 0.7,
      status: "completed",
      itemCount: 2,
      completedCount: 2,
      failedCount: 0,
      avgScore: 0.91,
      scoreBreakdown: { correctness: 0.9, faithfulness: 0.92 },
      createdAt: NOW.toISOString(),
    });

    expect(mocks.selectEvalItemResults).toHaveBeenCalledWith("evr_ABC");
    expect(out.results).toEqual([
      {
        itemId: "edi_1",
        targetKind: "model",
        model: "gateway/balanced",
        judgeModel: "gateway/precise-model",
        score: 0.95,
        correctness: 0.96,
        faithfulness: 0.94,
        passed: true,
        latencyMs: 812,
        inputTokens: 120,
        outputTokens: 48,
        costUsdMicros: 340,
        status: "completed",
        errorClass: "",
        output: "The answer is 4.",
        rationale: "Matches expected output.",
      },
      {
        itemId: "edi_2",
        targetKind: "model",
        model: "gateway/balanced",
        judgeModel: "gateway/precise-model",
        score: 0.2,
        correctness: 0.96,
        faithfulness: 0.94,
        passed: false,
        latencyMs: 812,
        inputTokens: 120,
        outputTokens: 48,
        costUsdMicros: 340,
        status: "completed",
        errorClass: "",
        output: "The answer is 4.",
        rationale: "Matches expected output.",
      },
    ]);
  });

  it("defaults a null scoreBreakdown and avgScore to {} / null", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([{ ...RUN_ROW, avgScore: null, scoreBreakdown: null }])),
    );
    mocks.selectEvalItemResults.mockResolvedValue([]);

    const out = await evalRunGetHandler({ runPublicId: "evr_ABC" }, CTX);
    expect(out.run.avgScore).toBeNull();
    expect(out.run.scoreBreakdown).toEqual({});
    expect(out.results).toEqual([]);
  });

  it("throws a 404 when the run does not exist", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) => fn(makeTx([])),
    );

    await expect(
      evalRunGetHandler({ runPublicId: "evr_missing" }, CTX),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(mocks.selectEvalItemResults).not.toHaveBeenCalled();
  });

  it("throws a 404 when the run belongs to a different workspace", async () => {
    mocks.withTenantDb.mockImplementation(
      (fn: (tx: TxLike) => Promise<unknown>) =>
        fn(makeTx([{ ...RUN_ROW, workspaceId: "ws_other" }])),
    );

    await expect(
      evalRunGetHandler({ runPublicId: "evr_ABC" }, CTX),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
