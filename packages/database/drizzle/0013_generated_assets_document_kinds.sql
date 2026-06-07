-- 0013_generated_assets_document_kinds.sql
-- Extend the generated_assets kind CHECK to allow document file types.
-- Forward migration (immutable after apply). See OXA-1650.

ALTER TABLE content.generated_assets
  DROP CONSTRAINT IF EXISTS generated_assets_kind_check;

ALTER TABLE content.generated_assets
  ADD CONSTRAINT generated_assets_kind_check
    CHECK (kind IN ('image', 'video', 'document', 'spreadsheet', 'presentation', 'pdf', 'archive'));
