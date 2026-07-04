// Read-side queries for `oxagen bench list` / `oxagen bench replay`.
// ClickHouse serializes 64-bit integer columns (UInt64) as JSON strings to
// avoid JS float-precision loss, so every row mapper below normalizes those
// fields back to `number` — safe here since public_ids/token counts never
// approach Number.MAX_SAFE_INTEGER (2^53-1).

import { clickhouse } from "../clickhouse";
import type { BenchmarkCandidateRow, BenchmarkRunResultRow, BenchmarkRunRow, BenchType } from "./types";

type RawRow = Record<string, unknown>;

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function toStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function toOptionalStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function toBit(v: unknown): 0 | 1 {
  return toNum(v) === 1 ? 1 : 0;
}

function mapRunRow(raw: RawRow): BenchmarkRunRow {
  return {
    id: toStr(raw.id),
    public_id: toNum(raw.public_id),
    bench_type: toStr(raw.bench_type),
    dataset: toStr(raw.dataset),
    agent: toStr(raw.agent),
    git_sha: toStr(raw.git_sha),
    config: toStr(raw.config),
    conditions: toStr(raw.conditions),
    n_tasks: toNum(raw.n_tasks),
    n_resolved: toNum(raw.n_resolved),
    resolved_rate: toNum(raw.resolved_rate),
    total_cost_usd: toNum(raw.total_cost_usd),
    tokens_in: toNum(raw.tokens_in),
    tokens_out: toNum(raw.tokens_out),
    tokens_cache: toNum(raw.tokens_cache),
    status: toStr(raw.status),
    notes: toStr(raw.notes),
    started_at: toStr(raw.started_at),
    finished_at: toStr(raw.finished_at),
    updated_at: toOptionalStr(raw.updated_at),
  };
}

function mapRunResultRow(raw: RawRow): BenchmarkRunResultRow {
  return {
    id: toStr(raw.id),
    public_id: toNum(raw.public_id),
    run_id: toStr(raw.run_id),
    run_public_id: toNum(raw.run_public_id),
    bench_type: toStr(raw.bench_type),
    dataset: toStr(raw.dataset),
    task_id: toStr(raw.task_id),
    task_source: toStr(raw.task_source),
    problem_statement: toStr(raw.problem_statement),
    gold_patch: toStr(raw.gold_patch),
    test_spec: toStr(raw.test_spec),
    config: toStr(raw.config),
    model_patch: toStr(raw.model_patch),
    n_candidates: toNum(raw.n_candidates),
    winner_candidate_id: toStr(raw.winner_candidate_id),
    winner_files: toNum(raw.winner_files),
    winner_steps: toNum(raw.winner_steps),
    tool_calls_json: toStr(raw.tool_calls_json) || "{}",
    code_graph_calls: toNum(raw.code_graph_calls),
    grep_calls: toNum(raw.grep_calls),
    reward: toNum(raw.reward),
    resolved: toBit(raw.resolved),
    verifier_stdout: toStr(raw.verifier_stdout),
    cost_usd: toNum(raw.cost_usd),
    tokens_in: toNum(raw.tokens_in),
    tokens_out: toNum(raw.tokens_out),
    tokens_cache: toNum(raw.tokens_cache),
    duration_s: toNum(raw.duration_s),
    status: toStr(raw.status),
    error: toStr(raw.error),
    started_at: toStr(raw.started_at),
    finished_at: toStr(raw.finished_at),
    updated_at: toOptionalStr(raw.updated_at),
  };
}

function mapCandidateRow(raw: RawRow): BenchmarkCandidateRow {
  const testsPassed = toNum(raw.tests_passed);
  return {
    id: toStr(raw.id),
    result_id: toStr(raw.result_id),
    result_public_id: toNum(raw.result_public_id),
    run_public_id: toNum(raw.run_public_id),
    candidate_id: toStr(raw.candidate_id),
    model: toStr(raw.model),
    is_winner: toBit(raw.is_winner),
    steps: toNum(raw.steps),
    files_changed: toNum(raw.files_changed),
    patch: toStr(raw.patch),
    tests_passed: testsPassed === 1 ? 1 : testsPassed === 0 ? 0 : -1,
    tool_calls_json: toStr(raw.tool_calls_json) || "{}",
    cost_usd: toNum(raw.cost_usd),
    tokens_in: toNum(raw.tokens_in),
    tokens_out: toNum(raw.tokens_out),
    updated_at: toOptionalStr(raw.updated_at),
  };
}

export interface ListBenchResultsOptions {
  benchType?: BenchType;
  /** Clamped to [1, 500]. Defaults to 20. */
  limit?: number;
}

/** Most recent task results, newest `public_id` first — the source for `oxagen bench list`. */
export async function listBenchResults(
  opts: ListBenchResultsOptions = {},
): Promise<BenchmarkRunResultRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500);
  const whereClause = opts.benchType ? "WHERE bench_type = {benchType:String}" : "";
  const result = await clickhouse().query({
    query: `
      SELECT *
      FROM bench.benchmark_run_result FINAL
      ${whereClause}
      ORDER BY public_id DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { benchType: opts.benchType ?? "", limit },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawRow[];
  return rows.map(mapRunResultRow);
}

/** The task result `oxagen bench replay <public_id>` reconstructs an env from. */
export async function getBenchResultByPublicId(publicId: number): Promise<BenchmarkRunResultRow | null> {
  const result = await clickhouse().query({
    query: `SELECT * FROM bench.benchmark_run_result FINAL WHERE public_id = {publicId:UInt64} LIMIT 1`,
    query_params: { publicId },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawRow[];
  return rows[0] ? mapRunResultRow(rows[0]) : null;
}

/** The parent run of a result — used to show run-level context (agent, dataset, conditions) alongside a replay. */
export async function getBenchRunByPublicId(publicId: number): Promise<BenchmarkRunRow | null> {
  const result = await clickhouse().query({
    query: `SELECT * FROM bench.benchmark_run FINAL WHERE public_id = {publicId:UInt64} LIMIT 1`,
    query_params: { publicId },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawRow[];
  return rows[0] ? mapRunRow(rows[0]) : null;
}

/** Every best-of-N candidate for one task result, e.g. for `oxagen bench replay --candidates`. */
export async function getBenchCandidatesForResult(resultPublicId: number): Promise<BenchmarkCandidateRow[]> {
  const result = await clickhouse().query({
    query: `
      SELECT *
      FROM bench.benchmark_candidate FINAL
      WHERE result_public_id = {resultPublicId:UInt64}
      ORDER BY candidate_id
    `,
    query_params: { resultPublicId },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as RawRow[];
  return rows.map(mapCandidateRow);
}
