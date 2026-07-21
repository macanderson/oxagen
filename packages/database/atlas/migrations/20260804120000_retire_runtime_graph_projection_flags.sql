-- Retire bookkeeping columns that existed only for the automatic Neo4j
-- execution and generated-file mirrors. PostgreSQL and private blob storage
-- remain authoritative; no customer execution or asset rows are removed.

ALTER TABLE "agent"."agent_executions"
  DROP COLUMN IF EXISTS "synced_to_graph_at";

ALTER TABLE "content"."generated_assets"
  DROP COLUMN IF EXISTS "synced_to_graph_at";
