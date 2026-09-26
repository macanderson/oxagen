-- Partial indexes for the run-enrichment sweep (#3784).
--
-- The sweep runs every five minutes and filtered tacho.sessions and
-- agent.agent_runs with no index that matched, so each sweep read every run a
-- workspace had ever recorded. Each index holds only the runs the sweep may
-- find due: never observed, failed last time, never enriched, changed since
-- the last read, or read with bodies missing. A run that was enriched and has
-- not changed since leaves the index.
--
-- The predicates match the Drizzle declarations exactly. The sweep builds its
-- WHERE clause from the same function (`runEnrichmentCandidate`), with
-- literals and no bind parameters, so Postgres can prove the query implies
-- each predicate and pick the index.
--
-- Not CONCURRENTLY: atlas runs a migration in a transaction. Both tables hold
-- one row per run, not one per event.
CREATE INDEX IF NOT EXISTS "tacho_sessions_enrichment_candidate_idx"
  ON "tacho"."sessions" ("org_id", "workspace_id")
  WHERE "parent_session_uuid" IS NULL
    AND ("summary_observed_at" IS NULL
      OR "summary_error" IS NOT NULL
      OR "summary_observed_revision" IS NULL
      OR "updated_at" IS DISTINCT FROM "summary_observed_revision"
      OR "summary_input_digest" LIKE 'partial:%');

CREATE INDEX IF NOT EXISTS "agent_runs_enrichment_candidate_idx"
  ON "agent"."agent_runs" ("org_id", "workspace_id")
  WHERE "spec_version" = 2
    AND ("summary_observed_at" IS NULL
      OR "summary_error" IS NOT NULL
      OR "summary_observed_revision" IS NULL
      OR "updated_at" IS DISTINCT FROM "summary_observed_revision"
      OR "summary_input_digest" LIKE 'partial:%');
