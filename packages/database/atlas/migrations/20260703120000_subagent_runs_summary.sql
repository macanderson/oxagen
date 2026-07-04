-- Adds agent.subagent_runs.summary — a structural ≤280-char digest of each
-- child run's output, written by the executor (agent.execute-subagent) when
-- the run completes. agent.subagent.aggregate returns this summary plus a
-- runId ref instead of relaying every child's full output payload into the
-- parent LLM's context; full payloads are fetched per-run on demand via
-- agent.subagent.result.get (docs/specs/graph-mediated-fanout).
--
-- Nullable by design: rows written before this column existed (and runs that
-- fail before producing output) have no summary — readers fall back to a
-- truncation of output_payload / error_reason.
ALTER TABLE agent.subagent_runs
  ADD COLUMN IF NOT EXISTS summary text;
