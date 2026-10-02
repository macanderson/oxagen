-- #5181: the index the Work list's check read needs.
--
-- list_work_items reads every fact of its items except the checks, reduces
-- them to find each send's current head commit, and then reads only the
-- check_observed facts on those heads (listFactsByItem in
-- packages/handlers/src/lib/work-read/read.ts). A busy send holds a check
-- fact for every check on every head its pull request had. Without this
-- index, that second read fetches every fact of each send through
-- item_facts_order_idx and drops the ones it does not need.
--
-- Partial on the same predicate the read writes as a literal, so only check
-- facts are indexed.
--
-- CREATE INDEX (not CONCURRENTLY): atlas runs a migration in a transaction,
-- and CONCURRENTLY cannot run inside one. work.item_facts is new in Phase 1
-- and small.

CREATE INDEX IF NOT EXISTS item_facts_check_head_idx
  ON work.item_facts (order_id, head_sha)
  WHERE kind = 'check_observed';
