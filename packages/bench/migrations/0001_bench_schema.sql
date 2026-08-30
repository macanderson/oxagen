-- 0001_bench_schema.sql
--
-- High-resolution benchmark storage: a dedicated `bench` database, separate
-- from the default CLICKHOUSE_DATABASE, so a bench-heavy retention/backup
-- policy never has to be reconciled with the rest of the telemetry estate.
--
-- This is the replay-capable companion to the cross-harness `eval_runs` /
-- `eval_results` protocol (packages/telemetry/src/schema.sql).
-- eval_runs/eval_results track "is the agent improving over time" with a
-- denormalized metrics/labels map, on purpose light on detail. `bench` keeps
-- full per-task and per-candidate fidelity — a secret-free config snapshot,
-- tool-call breakdowns, best-of-N candidate patches — so any one run can be
-- inspected or replayed exactly by public_id (the internal bench replay
-- command), which the denormalized eval shape cannot support. The two are
-- complementary, not duplicative: ingest into both when you want the trend
-- AND the detail.
--
-- Grain:
--   bench.benchmark_run         one row per Harbor job (a full harbor run
--                                invocation across N tasks).
--   bench.benchmark_run_result  one row per task/instance within a run. This
--                                is what `public_id` ("#2984") addresses for
--                                the internal bench replay command.
--   bench.benchmark_candidate   one row per best-of-N candidate within a
--                                result. Addressed via its parent's
--                                (run_public_id, result_public_id) plus its
--                                own `candidate_id` — it does not get its own
--                                public_id (nothing looks a candidate up by a
--                                bare number; see the SQL conventions policy
--                                "not every table needs a public_id").
--
-- `public_id` (benchmark_run / benchmark_run_result only) is a human-friendly
-- monotonic counter assigned at ingest time as max(public_id)+1 — ClickHouse
-- has no native autoincrement. It is a GLOBAL counter per table (not scoped
-- per bench_type), so "replay #2984" is never ambiguous. See
-- packages/bench/src/ingest.ts (nextPublicId). Best-effort unique
-- under concurrent ingestion, same documented tradeoff as
-- audit_events.chain_hash in clickhouse.ts — ingestion is expected to run
-- serially (backfill script / CI job), so this is acceptable.
--
-- All three tables use ReplacingMergeTree(updated_at) so a later write of the
-- same logical row (matched by ORDER BY key) collapses onto the earlier one —
-- read with FINAL, or tolerate rare duplicates pre-merge, same as eval_runs.
-- Note this only corrects a row when the rewrite REUSES its ORDER BY key.
-- Plain re-ingestion does not: ingestBenchResultsDir allocates a fresh
-- public_id every time, so `force: true` appends a new run rather than
-- replacing the old one.

CREATE DATABASE IF NOT EXISTS bench;

-- ---------------------------------------------------------------------------
-- bench.benchmark_run — one row per Harbor job.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bench.benchmark_run (
  -- Internal opaque key. benchmark_run_result.run_id / benchmark_candidate
  -- (transitively) reference this, never public_id.
  id UUID DEFAULT generateUUIDv4(),

  -- Human-friendly monotonic "#id" for CLI/chat references (e.g. "run #7").
  -- Assigned at ingest — see the header note above.
  public_id UInt64,

  -- Which harness produced this run, e.g. "swe-bench", "terminal-bench".
  -- Open string (not an enum) so a new harness never needs a migration.
  bench_type LowCardinality(String),

  -- Harbor dataset slug, e.g. "swe-bench/swe-bench-verified", "terminal-bench@2.0".
  dataset String,

  -- Agent under test, e.g. "oxagen", or a Harbor built-in competitor
  -- ("claude-code", "codex", "aider", ...).
  agent LowCardinality(String),

  -- Oxagen monorepo commit the CLI bundle was built from. Empty for
  -- non-oxagen competitor agents.
  git_sha String,

  -- Complete, secret-free replay payload: models list, N candidates,
  -- pipeline/verify flags, effort, evaluator/advisor slugs, revise rounds,
  -- task_ids, N_CONCURRENT, bundle git_sha. Env var keys are referenced BY
  -- NAME only — a value is never written here — so this column is always
  -- safe to read, log, or display. The internal bench replay command
  -- reconstructs the run env directly from this JSON.
  config String CODEC(ZSTD(3)),

  -- Host conditions at run time as JSON, e.g. {"host":"...","os":"darwin",
  -- "cpu":"...","docker_vm":"VZ"}. Informational only — not part of the
  -- replay contract (that's `config`).
  conditions String,

  n_tasks UInt16,
  n_resolved UInt16,
  resolved_rate Float32,

  total_cost_usd Float64,
  tokens_in UInt64,
  tokens_out UInt64,
  tokens_cache UInt64,

  -- 'completed' | 'partial' | 'running' | 'failed'. Open string
  -- (LowCardinality) so a harness-specific status never needs a migration.
  status LowCardinality(String),

  notes String,

  started_at DateTime,
  finished_at DateTime,
  -- When this row was first written (distinct from started_at — that's when
  -- the benchmark itself ran; this is when it landed in ClickHouse).
  ingested_at DateTime DEFAULT now(),
  updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (bench_type, public_id);

-- ---------------------------------------------------------------------------
-- bench.benchmark_run_result — one row per task/instance within a run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bench.benchmark_run_result (
  id UUID DEFAULT generateUUIDv4(),

  -- Human-friendly monotonic "#id" — the identifier the internal bench replay command
  -- takes. Global counter across the whole table, independent of
  -- run_public_id/bench_type, so "replay #2984" never needs disambiguation.
  public_id UInt64,

  run_id UUID,
  run_public_id UInt64,

  bench_type LowCardinality(String),
  dataset String,

  -- Bare task/instance id, namespace stripped (e.g. "django__django-11099",
  -- not "swe-bench/django__django-11099" — the namespace is already `dataset`).
  task_id String,

  -- Where the task definition itself came from, e.g. "swe-bench-verified",
  -- "terminal-bench-2.0". Kept distinct from `dataset` for parity with the
  -- eval protocol's `suite` column (a harness can re-slice a shared source).
  task_source LowCardinality(String),

  -- The task's natural-language instruction/issue body, taken from the agent
  -- trajectory's `start` event. Empty when the harness doesn't surface one.
  problem_statement String CODEC(ZSTD(3)),

  -- SWE-bench's reference fix, when available. Harbor does not expose this
  -- in the host results directory — it lives in the harness's internal
  -- dataset cache and is never written to disk here — so this is empty for
  -- ingestion sourced purely from a results dir. Left in the schema so a
  -- future ingester with dataset access can populate it without a migration.
  gold_patch String CODEC(ZSTD(3)),

  -- {"FAIL_TO_PASS": [...], "PASS_TO_PASS": [...]} test names this task's
  -- verifier graded against, from verifier/report.json.
  test_spec String CODEC(ZSTD(3)),

  -- Complete, secret-free replay config for THIS task alone (same shape and
  -- guarantee as benchmark_run.config, narrowed to one task_id).
  config String CODEC(ZSTD(3)),

  -- The winning candidate's applied diff. Harbor applies the winner directly
  -- inside the (ephemeral, deleted-after-run) task container and never
  -- persists a `git diff` back to the host results directory, so this is
  -- empty for every current ingestion path. Populate here if a future
  -- adapter change captures it as an artifact.
  model_patch String CODEC(ZSTD(3)),

  n_candidates UInt8,
  winner_candidate_id String,
  winner_files UInt16,
  winner_steps UInt16,

  -- {"code_graph": N, "grep": N, ...} summed across every candidate. See
  -- benchmark_candidate.tool_calls_json for the per-candidate breakdown.
  tool_calls_json String,
  code_graph_calls UInt16,
  grep_calls UInt16,

  -- Raw verifier reward (SWE-bench: 0.0/1.0; other harnesses may be continuous).
  reward Float32,
  -- 1 = verifier considered the task resolved (reward >= 1.0, or the
  -- harness's own `resolved` flag when it has one — e.g. SWE-bench's
  -- report.json). 0 otherwise.
  resolved UInt8,

  verifier_stdout String CODEC(ZSTD(3)),

  cost_usd Float64,
  tokens_in UInt64,
  tokens_out UInt64,
  tokens_cache UInt64,
  duration_s UInt32,

  -- 'completed' | 'errored' | 'incomplete' (e.g. no result.json — credit
  -- wall / timeout / cancelled mid-run).
  status LowCardinality(String),
  error String,

  started_at DateTime,
  finished_at DateTime,
  ingested_at DateTime DEFAULT now(),
  updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (bench_type, public_id);

-- ---------------------------------------------------------------------------
-- bench.benchmark_candidate — one row per best-of-N candidate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bench.benchmark_candidate (
  id UUID DEFAULT generateUUIDv4(),

  result_id UUID,
  result_public_id UInt64,
  run_public_id UInt64,

  -- e.g. "candidate-1" — unique within one task's best-of-N pool, not global.
  -- Addressed as (run_public_id, result_public_id, candidate_id); this table
  -- has no public_id of its own (nothing looks a candidate up by a bare
  -- number — see the SQL conventions policy on when public_id earns its place).
  candidate_id String,

  model String,
  is_winner UInt8,

  steps UInt16,
  files_changed UInt16,

  -- Same "Harbor never persists it to the host" caveat as
  -- benchmark_run_result.model_patch.
  patch String CODEC(ZSTD(3)),

  -- -1 unknown/not run (best-of-N does not thread per-candidate test results
  -- today — only the winner is verified) · 0 fail · 1 pass. Signed so
  -- "unknown" is representable without colliding with a real 0/1 outcome.
  tests_passed Int8,

  -- {"code_graph": N, "grep": N, ...} for this candidate alone.
  tool_calls_json String,

  -- Best-of-N does not thread per-candidate token/cost telemetry yet — the
  -- agent-arena adapter reports usage for the trial as a whole, not per
  -- candidate — so these stay 0 until that lands.
  cost_usd Float64,
  tokens_in UInt64,
  tokens_out UInt64,

  created_at DateTime DEFAULT now(),
  updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (run_public_id, result_public_id, candidate_id);
