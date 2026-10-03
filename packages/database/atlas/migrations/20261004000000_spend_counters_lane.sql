-- billing.spend_counters.lane (#5426): which of a workspace's own model calls
-- the spend belongs to, so each lane's daily budget reads its own row while
-- the org and workspace ceilings go on summing every row. '' keeps the rows
-- recorded before lanes, and spend outside the three lanes: a wrapped run's
-- own harness cost, an unlaned call.
--
-- The scope-day unique index gains the lane, so one recorder's
-- INSERT ... ON CONFLICT adds to its lane's row and not another's.

ALTER TABLE "billing"."spend_counters"
  ADD COLUMN "lane" text NOT NULL DEFAULT '';

ALTER TABLE "billing"."spend_counters"
  ADD CONSTRAINT "spend_counters_lane_check"
  CHECK (lane IN ('', 'run_enrichment', 'assistant', 'work'));

DROP INDEX IF EXISTS "billing"."spend_counters_scope_day_idx";
CREATE UNIQUE INDEX "spend_counters_scope_day_idx"
  ON "billing"."spend_counters" ("org_id", (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)), "day", "lane");
