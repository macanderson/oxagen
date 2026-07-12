-- 0002_bench_tokens_total.sql
--
-- Adds an authoritative `tokens_total` column to benchmark_run and
-- benchmark_run_result.
--
-- Why a separate total column instead of relying on tokens_in/out/cache:
-- the oxagen agent reports a single UNDIFFERENTIATED token total (see
-- oxagen_agent.py `_populate_best_of_n_usage` / `populate_context_post_run`,
-- which stamp `oxagen_total_tokens` onto agent_result.metadata) — it never
-- splits input/output/cache the way Harbor's built-in competitor adapters
-- (claude-code, codex, aider) do via agent_result.n_input_tokens et al.
-- Before this column existed, ingest.ts read only the split fields, so every
-- oxagen run landed with tokens_in/out/cache = 0 even though the total was
-- sitting in metadata — the "0s everywhere" bug. The split columns stay for
-- competitor agents that DO report the breakdown; `tokens_total` is the one
-- column that is always populated (metadata total for oxagen, sum of the
-- split for competitors), mirroring how summarize.py / eval_normalize.py
-- already normalize this.
--
-- ADD COLUMN IF NOT EXISTS is idempotent, so re-running the full migration
-- set (migrate.ts applies every *.sql in order) is safe. Existing rows keep
-- the UInt64 default of 0; re-ingest a results dir with force: true to
-- backfill a historical run's real total.

ALTER TABLE bench.benchmark_run
  ADD COLUMN IF NOT EXISTS tokens_total UInt64 AFTER tokens_cache;

ALTER TABLE bench.benchmark_run_result
  ADD COLUMN IF NOT EXISTS tokens_total UInt64 AFTER tokens_cache;
