-- Widen tacho.session_files line counts to bigint (#3944, audit finding S-02).
--
-- Git reconciliation assigns `lines_added` and `lines_removed` from the
-- envelope's u32, and an int4 column holds at most 2^31 - 1. A larger value
-- made Postgres refuse the upsert with 22003. Ingest answers that 400, so the
-- host quarantined the event and the session's dense-seq chain broke at it.
-- 20260925230200 widened every other counter the envelope feeds and missed
-- these two. `reads`, `writes`, `edits`, and `deletes` add one per event and
-- stay int4.
--
-- int4 to int8 rewrites the table under an ACCESS EXCLUSIVE lock. The table
-- holds one row per file a session touched, not one per event.

ALTER TABLE "tacho"."session_files"
  ALTER COLUMN "lines_added" TYPE bigint,
  ALTER COLUMN "lines_removed" TYPE bigint;

-- Keep the harness's self-reported session total in its own column (#3944,
-- audit finding S-07).
--
-- At `agent_stop` ingest wrote the harness's `total_cost_usd_micros` over
-- `total_cost_micros`, even for a session the host's model proxy metered
-- (`cost_basis = 'observed'`). The observed total was lost, and the session
-- row stopped agreeing with the spend counter, which adds only per-batch
-- deltas. Ingest now keeps the observed total and writes the harness's figure
-- here. A self-reported session still takes the harness's total, which also
-- lands here. Null until a session seals with a reported total.

ALTER TABLE "tacho"."sessions"
  ADD COLUMN "harness_reported_cost_micros" bigint NULL;

-- Record what enrichment has spent on each run, across jobs (#4312, audit
-- finding E-01).
--
-- `run.enrich` held each job to a budget, but every job started from zero,
-- and a live run is summarized again every 30 minutes while it changes, so a
-- run's total had no cap. The job now adds each model call's price here,
-- inside the step that made the call, and stops at the run's cap. The sweep
-- skips a run at its cap. NOT NULL DEFAULT 0 adds the column without
-- rewriting either table.

ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "summary_spent_usd_micros" bigint NOT NULL DEFAULT 0;

ALTER TABLE "tacho"."sessions"
  ADD COLUMN "summary_spent_usd_micros" bigint NOT NULL DEFAULT 0;
