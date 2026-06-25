-- Add synced_to_graph_at to content.generated_assets (idempotent).
-- NULL until the async Inngest function mirrors the asset into Neo4j as a
-- Document node linked to the originating Execution via a PRODUCED edge.
-- A nightly sweep can query WHERE synced_to_graph_at IS NULL AND status = 'ready'
-- to catch any missed rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'content'
      AND table_name = 'generated_assets'
      AND column_name = 'synced_to_graph_at'
  ) THEN
    ALTER TABLE "content"."generated_assets"
      ADD COLUMN "synced_to_graph_at" timestamptz;
  END IF;
END $$;
