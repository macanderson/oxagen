// Row shapes + shared types for the `bench` ClickHouse database
// (packages/bench/migrations/0001_bench_schema.sql). See that
// migration's header comment for how this relates to eval_runs/eval_results.
//
// The runs these rows describe are produced outside this repo, by the
// agent-arena harness (https://github.com/macanderson/agent-arena).

/** Which Harbor harness produced a run. Open string — a new harness never needs a migration. */
export type BenchType = "swe-bench" | "terminal-bench" | (string & {});

/** Run/result lifecycle. Open string (LowCardinality in ClickHouse) for the same reason. */
export type BenchStatus =
  | "completed"
  | "partial"
  | "running"
  | "failed"
  | "errored"
  | "incomplete"
  | (string & {});

/**
 * Secret-free replay payload for a bench run or task. Deliberately open —
 * new harnesses and new oxagen CLI flags should never require a migration.
 * Two key shapes, both understood by `buildReplayEnv` (see `replay-env.ts`):
 *
 * - **Raw env-var names** — how the agent-arena runner actually writes
 *   `bench-config.json`: every host `OXAGEN_*` var it forwards into the trial
 *   container verbatim, plus `DATASET`, `N_CONCURRENT`, `TASK_IDS`. These need
 *   no translation to replay — they're already valid shell assignments.
 * - **Conventional lower-camelCase keys** (all optional, all
 *   harness-dependent) for a config assembled by hand: `models`,
 *   `candidates`, `pipeline`, `verifyAuto`, `effort`, `evaluator`, `advisor`,
 *   `reviseRounds`, `taskIds`, `nConcurrent`, `bundleGitSha`, `dataset`, `warm`.
 *
 * NEVER put a secret VALUE here — env keys are referenced by name only
 * (e.g. `{"apiKeyEnv": "AI_GATEWAY_API_KEY"}`, never the key's value).
 * `ingestBenchResultsDir` runs `assertNoSecretValues` on this before every
 * insert (see `secrets.ts`) — note that means the raw-env-var shape must
 * never include `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY`/etc. themselves,
 * only the `OXAGEN_*` tuning vars.
 */
export type BenchReplayConfig = Record<string, unknown>;

/** Host conditions at run time, e.g. `{host, os, cpu, docker_vm}`. Informational only. */
export type BenchConditions = Record<string, unknown>;

/**
 * The `bench-config.json` snapshot the agent-arena runner writes into its
 * results dir before invoking `harbor run`. Read by `ingestBenchResultsDir`
 * as the primary config/conditions/gitSha source when present; a results dir
 * without one makes the caller supply those fields via `IngestBenchOptions`
 * instead.
 */
export interface BenchConfigSnapshot {
  gitSha?: string;
  config?: BenchReplayConfig;
  conditions?: BenchConditions;
}

// ---------------------------------------------------------------------------
// ClickHouse row shapes (mirror the migration's columns 1:1).
// ---------------------------------------------------------------------------

export interface BenchmarkRunRow {
  id: string;
  public_id: number;
  bench_type: BenchType;
  dataset: string;
  agent: string;
  git_sha: string;
  config: string;
  conditions: string;
  n_tasks: number;
  n_resolved: number;
  resolved_rate: number;
  total_cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  /** Authoritative total (oxagen reports only this; competitors sum their split). See migration 0002. */
  tokens_total: number;
  status: BenchStatus;
  notes: string;
  started_at: string;
  finished_at: string;
  updated_at?: string;
}

export interface BenchmarkRunResultRow {
  id: string;
  public_id: number;
  run_id: string;
  run_public_id: number;
  bench_type: BenchType;
  dataset: string;
  task_id: string;
  task_source: string;
  problem_statement: string;
  gold_patch: string;
  test_spec: string;
  config: string;
  model_patch: string;
  n_candidates: number;
  winner_candidate_id: string;
  winner_files: number;
  winner_steps: number;
  tool_calls_json: string;
  code_graph_calls: number;
  grep_calls: number;
  reward: number;
  resolved: 0 | 1;
  verifier_stdout: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cache: number;
  /** Authoritative total (oxagen reports only this; competitors sum their split). See migration 0002. */
  tokens_total: number;
  duration_s: number;
  status: BenchStatus;
  error: string;
  started_at: string;
  finished_at: string;
  updated_at?: string;
}

export interface BenchmarkCandidateRow {
  id: string;
  result_id: string;
  result_public_id: number;
  run_public_id: number;
  candidate_id: string;
  model: string;
  is_winner: 0 | 1;
  steps: number;
  files_changed: number;
  patch: string;
  /**
   * -1 unknown/not run · 0 fail · 1 pass. Ingestion only ever writes -1 or 0
   * today: best-of-N verifies the winner alone, so a candidate that did not
   * explicitly fail is unknown, not a proven pass. 1 is reserved for a future
   * adapter that grades every candidate.
   */
  tests_passed: -1 | 0 | 1;
  tool_calls_json: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Tool-call counting
// ---------------------------------------------------------------------------

/** Tool names counted from a best-of-N trajectory's `candidate-progress` labels. */
export const BENCH_TOOL_NAMES = [
  "code_graph",
  "semantic_search",
  "grep",
  "edit_file",
  "write_file",
  "read_file",
  "bash",
] as const;

export type BenchToolName = (typeof BENCH_TOOL_NAMES)[number];

/** Sparse map of tool name -> call count. Only tools actually observed are keyed. */
export type BenchToolCallCounts = Partial<Record<BenchToolName, number>>;

export interface BenchTestSpec {
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

// ---------------------------------------------------------------------------
// Ingestion options / summary
// ---------------------------------------------------------------------------

export interface IngestBenchOptions {
  benchType: BenchType;
  /**
   * Secret-free replay payload. Merged over (i.e. takes precedence over) any
   * `bench-config.json` snapshot found in the results dir.
   */
  config?: BenchReplayConfig;
  conditions?: BenchConditions;
  /** Falls back to the `bench-config.json` snapshot, then "". */
  gitSha?: string;
  /**
   * Total run cost in USD, when known out-of-band (e.g. from a billing
   * export). When omitted, the run's total_cost_usd is summed from the
   * per-task `agent_result.cost_usd` Harbor records for every agent, oxagen
   * included. Supply this only to override that sum with an authoritative
   * external figure.
   */
  costUsd?: number;
  /** Falls back to a name derived from config.json's agents[0].name. */
  agent?: string;
  /** Falls back to config.json's datasets[0].name. */
  dataset?: string;
  /** Falls back to "completed" when nothing was skipped, else "partial". */
  status?: BenchStatus;
  notes?: string;
  /**
   * Re-ingest even if a run matching (bench_type, dataset, git_sha,
   * started_at) already exists. Off by default — see `findExistingRun`.
   */
  force?: boolean;
}

export interface IngestBenchTaskSummary {
  taskId: string;
  publicId: number;
  resolved: boolean;
  reward: number;
}

export interface IngestBenchSkipped {
  taskId: string;
  reason: string;
}

export interface IngestBenchSummary {
  runId: string;
  runPublicId: number;
  /** True when ingestion was skipped entirely because a matching run already exists. */
  alreadyIngested: boolean;
  nTasks: number;
  nResolved: number;
  results: IngestBenchTaskSummary[];
  skipped: IngestBenchSkipped[];
}
