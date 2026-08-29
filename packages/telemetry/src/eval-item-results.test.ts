// Unit tests for insertEvalItemResults / selectEvalItemResults (Evals v1
// tenant-scoped per-item results). chInsert/chSelect (the tenant seam) are
// mocked so no live ClickHouse is needed; we assert the no-op-on-empty guard,
// the row shape passed to chInsert, and the tenant-filtered read + row shape
// from chSelect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(
  async (_table: string, _rows: readonly Record<string, unknown>[]) => {},
);
const chSelect = vi.fn(
  async <T>(_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as T[],
  }),
);

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) =>
    chInsert(table, rows),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import {
  insertEvalItemResults,
  selectEvalItemResults,
  selectEvalRunCostRollup,
} from "./eval-item-results";
import type { EvalItemResultRow } from "./eval-item-results";

const row: EvalItemResultRow = {
  run_id: "run-1",
  dataset_id: "dataset-1",
  item_id: "item-1",
  target_kind: "agent",
  model: "claude-sonnet-5",
  judge_model: "claude-sonnet-5",
  score: 0.9,
  correctness: 0.95,
  faithfulness: 0.85,
  passed: 1,
  latency_ms: 120,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd_micros: 500,
  status: "completed",
  error_class: "",
  output: "the answer",
  rationale: "matches the gold answer",
};

beforeEach(() => {
  chInsert.mockClear();
  chSelect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("insertEvalItemResults", () => {
  it("no-ops on an empty rows array (does not call chInsert)", async () => {
    await insertEvalItemResults([]);
    expect(chInsert).not.toHaveBeenCalled();
  });

  it("inserts every row into eval_item_results", async () => {
    await insertEvalItemResults([row]);
    expect(chInsert).toHaveBeenCalledTimes(1);
    expect(chInsert).toHaveBeenCalledWith("eval_item_results", [row]);
  });

  it("passes through multiple rows unmodified", async () => {
    const second: EvalItemResultRow = {
      ...row,
      item_id: "item-2",
      passed: 0,
      status: "failed",
    };
    await insertEvalItemResults([row, second]);
    const [, rows] = chInsert.mock.calls[0]!;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      item_id: "item-2",
      passed: 0,
      status: "failed",
    });
  });
});

describe("selectEvalItemResults", () => {
  it("queries eval_item_results filtered by runId and returns the rows", async () => {
    chSelect.mockResolvedValueOnce({ data: [row] });
    const result = await selectEvalItemResults("run-1");
    expect(result).toEqual([row]);
    expect(chSelect).toHaveBeenCalledTimes(1);
    const call = chSelect.mock.calls[0]![0] as {
      query: string;
      params?: Record<string, unknown>;
    };
    expect(call.query).toContain("FROM eval_item_results");
    expect(call.query).toContain("run_id = {runId:String}");
    expect(call.params).toEqual({ runId: "run-1" });
  });

  it("returns an empty array when the run has no results", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    const result = await selectEvalItemResults("run-empty");
    expect(result).toEqual([]);
  });

  it("coerces the Int64 cost_usd_micros the wire hands back as a string", async () => {
    // ClickHouse's JSON format serialises Int64 as a string; uncoerced it
    // failed get_eval_run's own output schema at results[].costUsdMicros.
    chSelect.mockResolvedValueOnce({
      data: [{ ...row, cost_usd_micros: "500" }],
    });
    const result = await selectEvalItemResults("run-1");
    expect(result[0]?.cost_usd_micros).toBe(500);
  });
});

describe("selectEvalRunCostRollup", () => {
  it("no-ops to an empty map on an empty id list (does not query)", async () => {
    const result = await selectEvalRunCostRollup([]);
    expect(result.size).toBe(0);
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("groups by run_id and coerces string sums to numbers", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        {
          run_id: "run-1",
          cost_usd_micros: "500",
          input_tokens: "1000",
          output_tokens: "400",
        },
        {
          run_id: "run-2",
          cost_usd_micros: 250,
          input_tokens: 300,
          output_tokens: 120,
        },
      ],
    });
    const result = await selectEvalRunCostRollup(["run-1", "run-2"]);
    expect(result.get("run-1")).toEqual({
      costUsdMicros: 500,
      inputTokens: 1000,
      outputTokens: 400,
    });
    expect(result.get("run-2")).toEqual({
      costUsdMicros: 250,
      inputTokens: 300,
      outputTokens: 120,
    });
    const call = chSelect.mock.calls[0]![0] as {
      query: string;
      params?: Record<string, unknown>;
    };
    expect(call.query).toContain("FROM eval_item_results");
    expect(call.query).toContain("run_id IN {runIds:Array(String)}");
    expect(call.query).toContain("GROUP BY run_id");
    expect(call.params).toEqual({ runIds: ["run-1", "run-2"] });
  });

  it("omits runs with no rows from the map (caller defaults them to zero)", async () => {
    chSelect.mockResolvedValueOnce({
      data: [
        {
          run_id: "run-1",
          cost_usd_micros: "10",
          input_tokens: "5",
          output_tokens: "3",
        },
      ],
    });
    const result = await selectEvalRunCostRollup(["run-1", "run-missing"]);
    expect(result.has("run-1")).toBe(true);
    expect(result.has("run-missing")).toBe(false);
  });
});
