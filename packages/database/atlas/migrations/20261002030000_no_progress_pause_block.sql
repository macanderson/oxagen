-- Why an enforced no-progress limit could not pause the run (spend spec,
-- detector 1; #4490).
--
-- An enforced limit pauses the run through the path an operator's pause
-- takes. A run with no governed call to pause at keeps the outcome
-- `would_pause`, and this column says why, so the Run page can name it:
-- the run had ended, its host cannot take a command, it has no connection
-- point for one, or the process that ran the check had no pause path.
--
-- NULL on every hit that paused the run and on every observe hit, which the
-- second check holds. Rows written before this migration keep NULL.
--
-- Shape mirrors the drizzle schema (packages/database/src/schema/cost.ts
-- `noProgressHits`).

ALTER TABLE "cost"."no_progress_hits" ADD COLUMN "pause_block" text;

ALTER TABLE "cost"."no_progress_hits"
	ADD CONSTRAINT "no_progress_hits_pause_block_check"
	CHECK ("pause_block" IS NULL OR "pause_block" IN ('run_sealed','no_host','host_revoked','host_offline','no_connection_point','pause_unavailable'));

ALTER TABLE "cost"."no_progress_hits"
	ADD CONSTRAINT "no_progress_hits_pause_block_outcome_check"
	CHECK ("pause_block" IS NULL OR ("mode" = 'enforced' AND "outcome" = 'would_pause'));
