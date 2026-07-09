// eval-item-results.test.ts — OXA-2059
//
// Unit tests for insertEvalItemResults / selectEvalItemResults (Evals v1
// tenant-scoped per-item results). This file previously had zero test
// coverage — chInsert/chSelect (the tenant seam) are mocked so no live
// ClickHouse is needed; we assert the no-op-on-empty guard, the row shape
// passed to chInsert, and the tenant-filtered read + row shape from chSelect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chInsert = vi.fn(async (_table: string, _rows: readonly Record<string, unknown>[]) => {});
const chSelect = vi.fn(async <T>(_q: { query: string; params?: Record<string, unknown> }) => ({
  data: [] as T[],
}));

vi.mock("./tenant", () => ({
  chInsert: (table: string, rows: readonly Record<string, unknown>[]) => chInsert(table, rows),
  chSelect: (q: { query: string; params?: Record<string, unknown> }) => chSelect(q),
}));

import { insertEvalItemResults, selectEvalItemResults } from "./eval-item-results";
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
    const second: EvalItemResultRow = { ...row, item_id: "item-2", passed: 0, status: "failed" };
    await insertEvalItemResults([row, second]);
    const [, rows] = chInsert.mock.calls[0]!;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ item_id: "item-2", passed: 0, status: "failed" });
  });
});

describe("selectEvalItemResults", () => {
  it("queries eval_item_results filtered by runId and returns the rows", async () => {
    chSelect.mockResolvedValueOnce({ data: [row] });
    const result = await selectEvalItemResults("run-1");
    expect(result).toEqual([row]);
    expect(chSelect).toHaveBeenCalledTimes(1);
    const call = chSelect.mock.calls[0]![0] as { query: string; params?: Record<string, unknown> };
    expect(call.query).toContain("FROM eval_item_results");
    expect(call.query).toContain("run_id = {runId:String}");
    expect(call.params).toEqual({ runId: "run-1" });
  });

  it("returns an empty array when the run has no results", async () => {
    chSelect.mockResolvedValueOnce({ data: [] });
    const result = await selectEvalItemResults("run-empty");
    expect(result).toEqual([]);
  });
});
