// query.test.ts — read-side queries backing the bench list/replay CLI.
//
// Mocks @oxagen/telemetry/bench-client (the only ClickHouse-touching
// dependency @oxagen/bench declares) directly — chBenchQuery is called with
// (query, params) positional args and resolves the rows straight, no more
// `{json: () => ...}` indirection since that's now handled once inside
// telemetry's bench-client.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@oxagen/telemetry/bench-client", () => ({
  chBenchQuery: queryMock,
}));

const RAW_RESULT_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  public_id: "42", // ClickHouse serializes UInt64 as a string
  run_id: "22222222-2222-2222-2222-222222222222",
  run_public_id: "3",
  bench_type: "swe-bench",
  dataset: "swe-bench/swe-bench-verified",
  task_id: "django__django-11099",
  task_source: "swe-bench-verified",
  problem_statement: "Fix the bug.",
  gold_patch: "",
  test_spec: '{"FAIL_TO_PASS":[],"PASS_TO_PASS":[]}',
  config: "{}",
  model_patch: "",
  n_candidates: 3,
  winner_candidate_id: "candidate-1",
  winner_files: 1,
  winner_steps: 8,
  tool_calls_json: '{"read_file":2}',
  code_graph_calls: 1,
  grep_calls: 0,
  reward: 1,
  resolved: 1,
  verifier_stdout: "OK",
  cost_usd: 0,
  tokens_in: "0",
  tokens_out: "0",
  tokens_cache: "0",
  duration_s: 120,
  status: "completed",
  error: "",
  started_at: "2026-07-03 14:26:34",
  finished_at: "2026-07-03 14:36:48",
  updated_at: "2026-07-03 14:36:48",
};

describe("listBenchResults", () => {
  let mod: typeof import("./query");

  beforeEach(async () => {
    queryMock.mockReset();
    vi.resetModules();
    mod = await import("./query");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("maps UInt64-as-string fields back to numbers", async () => {
    queryMock.mockResolvedValue([RAW_RESULT_ROW]);
    const rows = await mod.listBenchResults();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.public_id).toBe(42);
    expect(rows[0]!.run_public_id).toBe(3);
    expect(typeof rows[0]!.public_id).toBe("number");
  });

  it("orders by public_id DESC and clamps limit into [1, 500]", async () => {
    queryMock.mockResolvedValue([]);
    await mod.listBenchResults({ limit: 10_000 });
    const [query, params] = queryMock.mock.calls[0]! as [
      string,
      { limit: number },
    ];
    expect(query).toMatch(/ORDER BY public_id DESC/);
    expect(params.limit).toBe(500);

    await mod.listBenchResults({ limit: -5 });
    const [, params2] = queryMock.mock.calls[1]! as [string, { limit: number }];
    expect(params2.limit).toBe(1);
  });

  it("filters by bench_type only when provided", async () => {
    queryMock.mockResolvedValue([]);
    await mod.listBenchResults({ benchType: "terminal-bench" });
    const [query, params] = queryMock.mock.calls[0]! as [
      string,
      { benchType: string },
    ];
    expect(query).toMatch(/WHERE bench_type = /);
    expect(params.benchType).toBe("terminal-bench");

    await mod.listBenchResults();
    const [query2] = queryMock.mock.calls[1]! as [string];
    expect(query2).not.toMatch(/WHERE bench_type/);
  });

  it("returns an empty array when nothing matches", async () => {
    queryMock.mockResolvedValue([]);
    expect(await mod.listBenchResults()).toEqual([]);
  });
});

describe("getBenchResultByPublicId", () => {
  let mod: typeof import("./query");

  beforeEach(async () => {
    queryMock.mockReset();
    vi.resetModules();
    mod = await import("./query");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns the mapped row when found", async () => {
    queryMock.mockResolvedValue([RAW_RESULT_ROW]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.task_id).toBe("django__django-11099");
    expect(row?.tokens_in).toBe(0);
    const [, params] = queryMock.mock.calls[0]! as [
      string,
      { publicId: number },
    ];
    expect(params.publicId).toBe(42);
  });

  it("returns null when no row matches", async () => {
    queryMock.mockResolvedValue([]);
    expect(await mod.getBenchResultByPublicId(999)).toBeNull();
  });

  it("defaults tool_calls_json to '{}' when the column is empty", async () => {
    queryMock.mockResolvedValue([{ ...RAW_RESULT_ROW, tool_calls_json: "" }]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.tool_calls_json).toBe("{}");
  });

  it("normalizes a null/non-numeric field to 0 rather than NaN", async () => {
    queryMock.mockResolvedValue([
      {
        ...RAW_RESULT_ROW,
        reward: null,
        code_graph_calls: undefined,
        grep_calls: {},
      },
    ]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.reward).toBe(0);
    expect(row?.code_graph_calls).toBe(0);
    expect(row?.grep_calls).toBe(0);
  });

  it("normalizes an unparseable numeric string to 0", async () => {
    queryMock.mockResolvedValue([
      { ...RAW_RESULT_ROW, public_id: "not-a-number" },
    ]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.public_id).toBe(0);
  });

  it("defaults a non-string column to '' rather than throwing", async () => {
    queryMock.mockResolvedValue([{ ...RAW_RESULT_ROW, task_id: 12345 }]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.task_id).toBe("");
  });

  it("normalizes resolved: 0 (not just the truthy 1 case)", async () => {
    queryMock.mockResolvedValue([{ ...RAW_RESULT_ROW, resolved: 0 }]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.resolved).toBe(0);
  });

  it("omits updated_at when the column is absent or empty", async () => {
    queryMock.mockResolvedValue([{ ...RAW_RESULT_ROW, updated_at: "" }]);
    const row = await mod.getBenchResultByPublicId(42);
    expect(row?.updated_at).toBeUndefined();
  });
});

describe("getBenchRunByPublicId", () => {
  let mod: typeof import("./query");

  beforeEach(async () => {
    queryMock.mockReset();
    vi.resetModules();
    mod = await import("./query");
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("returns the mapped run row when found", async () => {
    queryMock.mockResolvedValue([
      {
        id: "33333333-3333-3333-3333-333333333333",
        public_id: "3",
        bench_type: "swe-bench",
        dataset: "swe-bench/swe-bench-verified",
        agent: "oxagen",
        git_sha: "abc123",
        config: "{}",
        conditions: "{}",
        n_tasks: 4,
        n_resolved: 1,
        resolved_rate: 0.25,
        total_cost_usd: 53.12,
        tokens_in: "0",
        tokens_out: "0",
        tokens_cache: "0",
        status: "partial",
        notes: "",
        started_at: "2026-07-03 14:59:00",
        finished_at: "2026-07-03 15:33:00",
      },
    ]);
    const run = await mod.getBenchRunByPublicId(3);
    expect(run?.public_id).toBe(3);
    expect(run?.total_cost_usd).toBe(53.12);
    expect(run?.status).toBe("partial");
  });

  it("returns null when no run matches", async () => {
    queryMock.mockResolvedValue([]);
    expect(await mod.getBenchRunByPublicId(999)).toBeNull();
  });
});

describe("getBenchCandidatesForResult", () => {
  let mod: typeof import("./query");

  beforeEach(async () => {
    queryMock.mockReset();
    vi.resetModules();
    mod = await import("./query");
  });

  afterEach(() => {
    vi.resetModules();
  });

  function rawCandidate(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      id: "c1",
      result_id: "r1",
      result_public_id: "42",
      run_public_id: "3",
      candidate_id: "candidate-1",
      model: "anthropic/claude-fable-5",
      is_winner: 1,
      steps: 5,
      files_changed: 1,
      patch: "",
      tests_passed: -1,
      tool_calls_json: "",
      cost_usd: 0,
      tokens_in: "0",
      tokens_out: "0",
      ...overrides,
    };
  }

  it("maps every candidate row, normalizing tests_passed to -1/0/1", async () => {
    queryMock.mockResolvedValue([rawCandidate({})]);
    const candidates = await mod.getBenchCandidatesForResult(42);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      result_public_id: 42,
      run_public_id: 3,
      is_winner: 1,
      tests_passed: -1,
      tool_calls_json: "{}",
    });
    const [, params] = queryMock.mock.calls[0]! as [
      string,
      { resultPublicId: number },
    ];
    expect(params.resultPublicId).toBe(42);
  });

  it("normalizes tests_passed: 1 (pass)", async () => {
    queryMock.mockResolvedValue([rawCandidate({ tests_passed: 1 })]);
    const candidates = await mod.getBenchCandidatesForResult(42);
    expect(candidates[0]?.tests_passed).toBe(1);
  });

  it("normalizes tests_passed: 0 (fail)", async () => {
    queryMock.mockResolvedValue([rawCandidate({ tests_passed: 0 })]);
    const candidates = await mod.getBenchCandidatesForResult(42);
    expect(candidates[0]?.tests_passed).toBe(0);
  });

  it("normalizes an out-of-range tests_passed value to -1 (unknown)", async () => {
    queryMock.mockResolvedValue([rawCandidate({ tests_passed: 5 })]);
    const candidates = await mod.getBenchCandidatesForResult(42);
    expect(candidates[0]?.tests_passed).toBe(-1);
  });

  it("returns an empty array when the result has no candidates", async () => {
    queryMock.mockResolvedValue([]);
    expect(await mod.getBenchCandidatesForResult(1)).toEqual([]);
  });
});
