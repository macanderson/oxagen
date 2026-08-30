/**
 * Eval-result protocol — the single boundary that lands eval runs in ClickHouse.
 *
 * Every harness (the TS engram golden suite and the Python bench suites) produces
 * a normalized run object; this module denormalizes it onto the `eval_runs` /
 * `eval_results` rows and inserts via @oxagen/telemetry. Keeping the insert in one
 * place means a harness never talks to ClickHouse directly — it just emits the
 * `oxagen.eval.v1` shape and hands it here (in-process for TS, via a `.eval.json`
 * file for Python; see eval-ingest.ts / run-evals.ts).
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  clickhouse,
  insertEvalRun,
  insertEvalResults,
  type EvalRunRow,
  type EvalResultRow,
} from "@oxagen/telemetry";

/** The normalized run header a harness emits (a superset of EvalRunRow minus denormalized dims). */
export interface NormalizedRun {
  run_id: string;
  run_group?: string;
  agent_name: string;
  agent_version: string;
  model: string;
  harness: string;
  suite: string;
  suite_version?: string;
  git_sha?: string;
  git_branch?: string;
  environment?: string;
  config_hash?: string;
  graph_code?: 0 | 1;
  graph_exec?: 0 | 1;
  graph_mem?: 0 | 1;
  warm?: 0 | 1;
  history_depth?: number;
  seed?: number;
  n_tasks?: number;
  n_passed?: number;
  resolved_rate?: number;
  metrics?: Record<string, number>;
  labels?: Record<string, string>;
  notes?: string;
}

/** A per-task result; harness/suite/agent dims are denormalized from the run header. */
export interface NormalizedResult {
  task_id: string;
  task_group?: string;
  repeat_idx?: number;
  passed?: 0 | 1;
  reward?: number;
  metrics?: Record<string, number>;
  labels?: Record<string, string>;
}

/** The `oxagen.eval.v1` file shape. */
export interface EvalRunFile {
  schema?: string;
  run: NormalizedRun;
  results?: NormalizedResult[];
}

/** True when the ClickHouse connection env is present (so callers can skip gracefully). */
export function clickhouseConfigured(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_DATABASE);
}

/** Best-effort git provenance to stamp on runs that didn't set it. */
export function gitProvenance(): { git_sha: string; git_branch: string } {
  const read = (cmd: string): string => {
    try {
      return execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  return {
    git_sha: read("git rev-parse --short HEAD"),
    git_branch: read("git rev-parse --abbrev-ref HEAD"),
  };
}

function toRunRow(run: NormalizedRun): EvalRunRow {
  const git = gitProvenance();
  return {
    ...run,
    git_sha: run.git_sha || git.git_sha,
    git_branch: run.git_branch || git.git_branch,
    environment: run.environment || (process.env.CI ? "ci" : "local"),
  };
}

function toResultRows(
  run: NormalizedRun,
  results: NormalizedResult[],
): EvalResultRow[] {
  return results.map((r) => ({
    run_id: run.run_id,
    task_id: r.task_id,
    task_group: r.task_group,
    repeat_idx: r.repeat_idx,
    harness: run.harness,
    suite: run.suite,
    agent_name: run.agent_name,
    agent_version: run.agent_version,
    model: run.model,
    graph_code: run.graph_code,
    graph_exec: run.graph_exec,
    graph_mem: run.graph_mem,
    warm: run.warm,
    history_depth: run.history_depth,
    passed: r.passed,
    reward: r.reward,
    metrics: r.metrics,
    labels: r.labels,
  }));
}

/** Has this run_id already been ingested? (eval_results is append-only — avoid dupes.) */
async function runExists(runId: string): Promise<boolean> {
  const result = await clickhouse().query({
    query: "SELECT count() AS n FROM eval_runs WHERE run_id = {rid:String}",
    query_params: { rid: runId },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ n: string }>;
  return Number(rows[0]?.n ?? 0) > 0;
}

export interface IngestResult {
  run_id: string;
  status: "ingested" | "skipped-exists" | "skipped-no-clickhouse";
  results: number;
}

/**
 * Insert one normalized run (header + per-task results) into ClickHouse. Idempotent
 * by run_id unless `force` — re-ingesting the same run is a no-op (the run header
 * upserts under ReplacingMergeTree, but eval_results is append-only, so we skip to
 * avoid duplicate task rows).
 */
export async function ingestRun(
  file: EvalRunFile,
  opts: { force?: boolean } = {},
): Promise<IngestResult> {
  const run = file.run;
  if (!clickhouseConfigured()) {
    return { run_id: run.run_id, status: "skipped-no-clickhouse", results: 0 };
  }
  if (!opts.force && (await runExists(run.run_id))) {
    return { run_id: run.run_id, status: "skipped-exists", results: 0 };
  }
  const results = file.results ?? [];
  await insertEvalRun(toRunRow(run));
  await insertEvalResults(toResultRows(run, results));
  return { run_id: run.run_id, status: "ingested", results: results.length };
}

/** Read a `.eval.json` file → one or many EvalRunFile objects (the file may be an array). */
export function loadEvalFile(path: string): EvalRunFile[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as
    | EvalRunFile
    | EvalRunFile[];
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.filter((f) => f && f.run && f.run.run_id);
}
