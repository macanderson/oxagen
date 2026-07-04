-- 0020_eval_item_results.sql
--
-- Per-item results for customer-facing Evals v1 (eval.run.start). DISTINCT from
-- the private bench-harness eval_runs/eval_results tables above: those are
-- internal SWE-bench/engram-golden benchmarks with NO tenant columns. This
-- table is tenant-scoped (org_id/workspace_id) so it is written via chInsert
-- (stamps scope) and read via chSelect (fail-closed org_id filter), keeping
-- customer eval detail isolated per workspace.
--
-- One append-only row per (run, dataset item): the target's output, the LLM
-- judge's scores, and the metering slice (tokens, latency, cost) for that item.
-- Run-level summary lives in Postgres eval.eval_runs; this is the drill-down.
--
-- Engine: MergeTree (pure append-only; a run writes each item exactly once).
CREATE TABLE IF NOT EXISTS eval_item_results (
  org_id UUID,
  workspace_id UUID,
  -- eval.eval_runs.public_id (evr_…) and eval.eval_dataset_items.public_id (evi_…).
  run_id String,
  dataset_id String,
  item_id String,
  -- 'model' | 'agent' — what was evaluated.
  target_kind LowCardinality(String) DEFAULT '',
  -- Resolved gateway model ids for the target and the judge (reproducibility).
  model LowCardinality(String) DEFAULT '',
  judge_model LowCardinality(String) DEFAULT '',
  -- Judge rubric scores in [0,1]. `score` is the overall; the axes break it down.
  score Float64 DEFAULT 0,
  correctness Float64 DEFAULT 0,
  faithfulness Float64 DEFAULT 0,
  -- 1 when score >= the run's pass_threshold.
  passed UInt8 DEFAULT 0,
  -- Metering slice for this item (target + judge combined).
  latency_ms UInt32 DEFAULT 0,
  input_tokens UInt32 DEFAULT 0,
  output_tokens UInt32 DEFAULT 0,
  cost_usd_micros Int64 DEFAULT 0,
  -- 'completed' | 'failed' — per-item outcome.
  status LowCardinality(String) DEFAULT 'completed',
  error_class LowCardinality(String) DEFAULT '',
  -- The target's produced answer and the judge's rationale (ZSTD — free text).
  output String CODEC(ZSTD(3)),
  rationale String CODEC(ZSTD(3)),
  created_at DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, run_id, item_id, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;
