-- generated_assets: support USER-UPLOADED attachments alongside AI-generated media.
--
-- The in-app agent (and CLI/API/MCP) can now attach user-supplied images/videos/
-- documents to a chat turn. Rather than a second table, uploads reuse
-- generated_assets so conversation.files.list, the /api/v1/assets serve route,
-- the org/user/public access policy, and the Neo4j graph-sync job all keep
-- working unchanged. Two shape changes make the table honest for uploads:
--
--   source   generated | user_upload — provenance discriminator. 'generated'
--            rows carry a real prompt + model; 'user_upload' rows do not.
--   prompt   relaxed to DEFAULT '' — an uploaded asset has no generation prompt.
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken by
-- the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).

ALTER TABLE content.generated_assets
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'generated';

ALTER TABLE content.generated_assets
  DROP CONSTRAINT IF EXISTS generated_assets_source_check;

ALTER TABLE content.generated_assets
  ADD CONSTRAINT generated_assets_source_check
  CHECK (source IN ('generated', 'user_upload'));

-- Uploaded assets have no generation prompt; give the column a default so an
-- INSERT that omits it succeeds. Existing rows already carry a non-null prompt.
ALTER TABLE content.generated_assets
  ALTER COLUMN prompt SET DEFAULT '';
