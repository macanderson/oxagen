// Typed ingestion for the `bench` ClickHouse database — parses a Harbor
// results directory and inserts one benchmark_run row, one
// benchmark_run_result row per task, and one benchmark_candidate row per
// best-of-N candidate. See packages/bench/migrations/0001_bench_schema.sql
// for the schema.
//
// The harness that PRODUCES those results directories is not in this repo.
// It lives at https://github.com/macanderson/agent-arena (its swe-bench and
// terminal-bench runners write the layout documented on
// `ingestBenchResultsDir` below). This package only reads what that harness
// left on disk, so it never has to be in the same repo as the runner.
//
// This package never imports @oxagen/telemetry's raw `clickhouse()` client
// directly — it goes through chBenchInsert/chBenchQuery, the thin unscoped
// wrappers telemetry exposes specifically for bench's non-tenant data (see
// packages/telemetry/src/bench-client.ts).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { chBenchInsert, chBenchQuery } from "@oxagen/telemetry/bench-client";
import { assertNoSecretValues } from "./secrets";
import {
  agentCostUsd,
  agentNameFromHarborConfig,
  agentSplitTokens,
  agentTotalTokens,
  bareTaskId,
  bestOfNMetadata,
  durationSeconds,
  parseTrajectory,
  parseVerifierReport,
  rewardOf,
  toolCallCount,
  type HarborRunConfig,
  type HarborTaskResult,
  type HarborVerifierReport,
} from "./harbor-parse";
import type {
  BenchConfigSnapshot,
  BenchmarkCandidateRow,
  BenchmarkRunResultRow,
  BenchmarkRunRow,
  BenchReplayConfig,
  IngestBenchOptions,
  IngestBenchSkipped,
  IngestBenchSummary,
  IngestBenchTaskSummary,
} from "./types";

// Cap on verifier stdout captured per task. Verifier logs can run to tens of
// thousands of lines on a large suite; ZSTD compresses well but an unbounded
// blob still isn't worth it for a column nobody reads past the first screen.
const MAX_VERIFIER_STDOUT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// fs helpers
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonOptional<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return readJson<T>(path);
  } catch {
    return null;
  }
}

function readTextOptional(path: string, maxChars: number): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function listSubdirectories(dir: string): string[] {
  return readdirSync(dir).filter((name) =>
    statSync(join(dir, name)).isDirectory(),
  );
}

/**
 * "YYYY-MM-DD HH:MM:SS" — ClickHouse's native DateTime literal format,
 * sub-second and timezone-suffix free regardless of `date_time_input_format`.
 *
 * Caveat: Harbor's own run-level result.json emits a naive (no "Z"/offset)
 * `started_at` (e.g. "2026-07-03T14:26:34.734249"), while its per-task
 * result.json timestamps are proper UTC ("...Z"). `Date.parse` treats a
 * naive string as local time OF THE MACHINE RUNNING THIS CODE, not the
 * machine that produced the log — so a run-level timestamp ingested from a
 * different timezone than the one Harbor ran in can be off by that offset.
 * This is an upstream Harbor data-quality gap, not something ingestion can
 * correct without knowing the origin machine's zone; task-level timestamps
 * (always "Z"-suffixed in practice) are unaffected.
 */
function toClickHouseDateTime(iso: string | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN;
  const date = Number.isNaN(ms) ? new Date() : new Date(ms);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** "swe-bench/swe-bench-verified" -> "swe-bench-verified" (drop the harness namespace prefix). */
function stripNamespace(value: string): string {
  const slash = value.indexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

// ---------------------------------------------------------------------------
// public_id allocation + idempotency guard
// ---------------------------------------------------------------------------

function parseChUInt(value: string | number | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Next `public_id` to assign in `table`, i.e. max(public_id)+1. Fetched once
 * per ingest call and incremented locally by the caller for however many
 * rows it writes in this pass — a fresh query per row would not see
 * not-yet-flushed rows from the same batch anyway (inserts are batched at
 * the end of `ingestBenchResultsDir`, not streamed per row).
 *
 * ClickHouse has no autoincrement and no unique constraint, so this is
 * read-then-write: two ingests running at the same time both read the same
 * max and both write it. Ingestion is expected to be serial (a backfill
 * script or a CI job), which is the tradeoff the schema header records.
 */
async function nextPublicId(
  table: "benchmark_run" | "benchmark_run_result",
): Promise<number> {
  const rows = await chBenchQuery<{ m: string | number }>(
    `SELECT max(public_id) AS m FROM bench.${table}`,
  );
  return parseChUInt(rows[0]?.m) + 1;
}

interface ExistingRunCriteria {
  benchType: string;
  dataset: string;
  gitSha: string;
  startedAt: string;
}

/** public_id of an already-ingested run matching (bench_type, dataset, git_sha, started_at), or null. */
async function findExistingRunPublicId(
  criteria: ExistingRunCriteria,
): Promise<number | null> {
  const rows = await chBenchQuery<{ public_id: string | number }>(
    `
      SELECT public_id
      FROM bench.benchmark_run FINAL
      WHERE bench_type = {benchType:String}
        AND dataset = {dataset:String}
        AND git_sha = {gitSha:String}
        AND started_at = {startedAt:DateTime}
      LIMIT 1
    `,
    {
      benchType: criteria.benchType,
      dataset: criteria.dataset,
      gitSha: criteria.gitSha,
      startedAt: toClickHouseDateTime(criteria.startedAt),
    },
  );
  const row = rows[0];
  return row ? parseChUInt(row.public_id) : null;
}

// ---------------------------------------------------------------------------
// Insert wrappers — bench.* is a separate database from the client's default
// (CLICKHOUSE_DATABASE), so every statement fully-qualifies the table name,
// same as the migration's CREATE TABLE bench.<name> statements.
// ---------------------------------------------------------------------------

export async function insertBenchmarkRun(row: BenchmarkRunRow): Promise<void> {
  await chBenchInsert("bench.benchmark_run", [row]);
}

export async function insertBenchmarkRunResults(
  rows: readonly BenchmarkRunResultRow[],
): Promise<void> {
  await chBenchInsert("bench.benchmark_run_result", rows);
}

export async function insertBenchmarkCandidates(
  rows: readonly BenchmarkCandidateRow[],
): Promise<void> {
  await chBenchInsert("bench.benchmark_candidate", rows);
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

/**
 * Parse a Harbor results directory and insert it into bench.benchmark_run /
 * bench.benchmark_run_result / bench.benchmark_candidate.
 *
 * Directory shape (Harbor's own layout):
 *   <dir>/config.json                 Harbor run config
 *   <dir>/result.json                 Harbor run rollup (job id, timestamps)
 *   <dir>/bench-config.json           optional oxagen replay snapshot, written
 *                                     by the agent-arena runner before it
 *                                     invokes `harbor run`
 *   <dir>/<task>__<hash>/result.json  per-task trial result (absent = the
 *                                     trial never finished — skipped, not fatal)
 *   <dir>/<task>__<hash>/agent/oxagen.txt        best-of-N JSONL trajectory
 *   <dir>/<task>__<hash>/verifier/report.json    SWE-bench resolved + test spec
 *   <dir>/<task>__<hash>/verifier/test-stdout.txt
 */
export async function ingestBenchResultsDir(
  dir: string,
  options: IngestBenchOptions,
): Promise<IngestBenchSummary> {
  const harborConfig = readJson<HarborRunConfig>(join(dir, "config.json"));
  const jobResult = readJsonOptional<{
    id?: string;
    started_at?: string;
    finished_at?: string;
  }>(join(dir, "result.json"));
  const snapshot = readJsonOptional<BenchConfigSnapshot>(
    join(dir, "bench-config.json"),
  );

  const benchType = options.benchType;
  const dataset = options.dataset ?? harborConfig.datasets?.[0]?.name ?? "";
  const agent = options.agent ?? agentNameFromHarborConfig(harborConfig);
  const gitSha = options.gitSha ?? snapshot?.gitSha ?? "";
  const config: BenchReplayConfig = { ...snapshot?.config, ...options.config };
  const conditions: BenchReplayConfig = {
    ...snapshot?.conditions,
    ...options.conditions,
  };
  assertNoSecretValues(config, "config");
  assertNoSecretValues(conditions, "conditions");

  // A results dir with no run-level result.json has no start time to recover,
  // so we stamp "now". That value is also part of the idempotency key below,
  // and it differs on every pass — so such a dir is NOT protected against
  // double ingestion: each run of this function appends another run row.
  const startedAtIso = jobResult?.started_at ?? new Date().toISOString();
  const finishedAtIso = jobResult?.finished_at ?? startedAtIso;

  const existingPublicId = await findExistingRunPublicId({
    benchType,
    dataset,
    gitSha,
    startedAt: startedAtIso,
  });
  if (existingPublicId !== null && !options.force) {
    return {
      runId: "",
      runPublicId: existingPublicId,
      alreadyIngested: true,
      nTasks: 0,
      nResolved: 0,
      results: [],
      skipped: [],
    };
  }

  const taskSource = stripNamespace(dataset);
  const taskDirNames = listSubdirectories(dir);

  const runId = randomUUID();
  const runPublicId = await nextPublicId("benchmark_run");
  let nextResultPublicId = await nextPublicId("benchmark_run_result");

  const resultRows: BenchmarkRunResultRow[] = [];
  const candidateRows: BenchmarkCandidateRow[] = [];
  const results: IngestBenchTaskSummary[] = [];
  const skipped: IngestBenchSkipped[] = [];

  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCache = 0;
  let tokensTotal = 0;
  let costSum = 0;

  for (const taskDirName of taskDirNames) {
    const taskDir = join(dir, taskDirName);
    const resultPath = join(taskDir, "result.json");
    if (!existsSync(resultPath)) {
      skipped.push({
        taskId: taskDirName,
        reason: "no result.json (trial did not finish)",
      });
      continue;
    }

    const trial = readJson<HarborTaskResult>(resultPath);
    const taskId = bareTaskId(trial) || taskDirName;
    const reward = rewardOf(trial);
    const bestOfN = bestOfNMetadata(trial);

    const verifierReport = readJsonOptional<HarborVerifierReport>(
      join(taskDir, "verifier", "report.json"),
    );
    const { resolved: reportResolved, testSpec } = parseVerifierReport(
      verifierReport,
      taskId,
    );
    const resolved: 0 | 1 =
      reportResolved !== null ? (reportResolved ? 1 : 0) : reward >= 1 ? 1 : 0;

    const verifierStdout = readTextOptional(
      join(taskDir, "verifier", "test-stdout.txt"),
      MAX_VERIFIER_STDOUT_CHARS,
    );
    const trajectoryText = readTextOptional(
      join(taskDir, "agent", "oxagen.txt"),
      Number.MAX_SAFE_INTEGER,
    );
    const trajectory = parseTrajectory(trajectoryText);

    // Split fields are populated by Harbor's built-in competitor adapters;
    // the oxagen adapter leaves them null and reports one total in metadata,
    // so `totalTok` is the authoritative number for every agent (see
    // `agentTotalTokens`). cost_usd is recorded by Harbor for oxagen too —
    // read it, don't hardcode 0.
    const split = agentSplitTokens(trial);
    const totalTok = agentTotalTokens(trial);
    const costUsd = agentCostUsd(trial);
    tokensIn += split.in;
    tokensOut += split.out;
    tokensCache += split.cache;
    tokensTotal += totalTok;
    costSum += costUsd;

    const resultPublicId = nextResultPublicId++;
    const startedAt =
      trial.agent_execution?.started_at ?? trial.started_at ?? startedAtIso;
    const finishedAt =
      trial.agent_execution?.finished_at ?? trial.finished_at ?? startedAt;

    resultRows.push({
      id: randomUUID(),
      public_id: resultPublicId,
      run_id: runId,
      run_public_id: runPublicId,
      bench_type: benchType,
      dataset,
      task_id: taskId,
      task_source: taskSource,
      problem_statement: trajectory.problemStatement,
      gold_patch: "",
      test_spec: JSON.stringify(testSpec),
      config: JSON.stringify({ ...config, taskId }),
      model_patch: "",
      n_candidates: bestOfN.nCandidates || trajectory.candidates.length,
      winner_candidate_id:
        bestOfN.winnerCandidateId || trajectory.winnerCandidateId,
      winner_files: bestOfN.winnerFiles || trajectory.winnerFiles,
      winner_steps: bestOfN.winnerSteps,
      tool_calls_json: JSON.stringify(trajectory.aggregateToolCalls),
      code_graph_calls: toolCallCount(
        trajectory.aggregateToolCalls,
        "code_graph",
      ),
      grep_calls: toolCallCount(trajectory.aggregateToolCalls, "grep"),
      reward,
      resolved,
      verifier_stdout: verifierStdout,
      cost_usd: costUsd,
      tokens_in: split.in,
      tokens_out: split.out,
      tokens_cache: split.cache,
      tokens_total: totalTok,
      duration_s: durationSeconds(trial),
      status: trial.exception_info ? "errored" : "completed",
      error: trial.exception_info ? JSON.stringify(trial.exception_info) : "",
      started_at: toClickHouseDateTime(startedAt),
      finished_at: toClickHouseDateTime(finishedAt),
    });

    for (const candidate of trajectory.candidates) {
      candidateRows.push({
        id: randomUUID(),
        result_id: resultRows[resultRows.length - 1]!.id,
        result_public_id: resultPublicId,
        run_public_id: runPublicId,
        candidate_id: candidate.id,
        model: candidate.model,
        is_winner: candidate.isWinner ? 1 : 0,
        steps: candidate.steps,
        files_changed: candidate.filesChanged,
        patch: "",
        tests_passed: candidate.failed ? 0 : -1,
        tool_calls_json: JSON.stringify(candidate.toolCalls),
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
      });
    }

    results.push({
      taskId,
      publicId: resultPublicId,
      resolved: resolved === 1,
      reward,
    });
  }

  const nTasks = results.length;
  const nResolved = results.filter((r) => r.resolved).length;
  const resolvedRate = nTasks > 0 ? nResolved / nTasks : 0;
  const status =
    options.status ?? (skipped.length > 0 ? "partial" : "completed");

  await insertBenchmarkRun({
    id: runId,
    public_id: runPublicId,
    bench_type: benchType,
    dataset,
    agent,
    git_sha: gitSha,
    config: JSON.stringify(config),
    conditions: JSON.stringify(conditions),
    n_tasks: nTasks,
    n_resolved: nResolved,
    resolved_rate: resolvedRate,
    // Prefer an out-of-band total (e.g. a billing export) when supplied;
    // otherwise sum the per-task cost Harbor recorded on each agent_result.
    total_cost_usd: options.costUsd ?? costSum,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_cache: tokensCache,
    tokens_total: tokensTotal,
    status,
    notes: options.notes ?? "",
    started_at: toClickHouseDateTime(startedAtIso),
    finished_at: toClickHouseDateTime(finishedAtIso),
  });
  await insertBenchmarkRunResults(resultRows);
  await insertBenchmarkCandidates(candidateRows);

  return {
    runId,
    runPublicId,
    alreadyIngested: false,
    nTasks,
    nResolved,
    results,
    skipped,
  };
}
