-- Add source discriminator to content.generated_assets (idempotent).
--
-- 'generated' (default) = media produced by the in-app agent's image/video
-- generation; 'user_upload' = a chat/agent attachment the user supplied via
-- asset.upload. Lets conversation.files.list and the Neo4j graph sync tell model
-- output apart from user-provided media without depending on the prompt column
-- (user uploads carry an empty prompt). Backfills existing rows to 'generated'
-- via the column default, matching their historical (all-generated) provenance.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'content'
      AND table_name = 'generated_assets'
      AND column_name = 'source'
  ) THEN
    ALTER TABLE "content"."generated_assets"
      ADD COLUMN "source" text NOT NULL DEFAULT 'generated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'content'
      AND table_name = 'generated_assets'
      AND constraint_name = 'generated_assets_source_check'
  ) THEN
    ALTER TABLE "content"."generated_assets"
      ADD CONSTRAINT "generated_assets_source_check"
      CHECK ("source" IN ('generated', 'user_upload'));
  END IF;
END $$;
