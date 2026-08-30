-- 0002_bench_tokens_total.sql
--
-- Adds an authoritative `tokens_total` column to benchmark_run and
-- benchmark_run_result.
--
-- Why a separate total column instead of relying on tokens_in/out/cache:
-- the oxagen agent reports a single UNDIFFERENTIATED token total (the
-- agent-arena adapter stamps `oxagen_total_tokens` onto
-- agent_result.metadata) — it never splits input/output/cache the way
-- Harbor's built-in competitor adapters (claude-code, codex, aider) do via
-- agent_result.n_input_tokens et al. The split columns stay for competitor
-- agents that DO report the breakdown; `tokens_total` is the one column that
-- is always populated (metadata total for oxagen, sum of the split for
-- competitors), mirroring how agent-arena's own summarizer normalizes this.
--
-- ADD COLUMN IF NOT EXISTS is idempotent, so re-running the full migration
-- set (migrate.ts applies every *.sql in order) is safe.
--
-- A row ingested before this column existed keeps the UInt64 default of 0.
-- There is no in-place backfill: `force: true` re-ingestion allocates a FRESH
-- public_id (see nextPublicId in ingest.ts), so it appends a second run row
-- rather than correcting the first. Backfilling an old row means writing it
-- yourself with its original public_id and a newer updated_at, so
-- ReplacingMergeTree collapses the pair on merge.

ALTER TABLE bench.benchmark_run
  ADD COLUMN IF NOT EXISTS tokens_total UInt64 AFTER tokens_cache;

ALTER TABLE bench.benchmark_run_result
  ADD COLUMN IF NOT EXISTS tokens_total UInt64 AFTER tokens_cache;
