-- 0007_content_soft_delete.sql
--
-- Add soft-delete columns to the org-scoped content tables (content.files,
-- content.documents) to match the softDeleteMixin already applied to
-- content.generated_assets and the engineering-policy rule that org-owned
-- tables soft-delete rather than hard-delete. Nullable + additive; no backfill.
-- Idempotent (ADD COLUMN IF NOT EXISTS) so it is safe on partially-applied DBs.
ALTER TABLE content.files ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE content.files ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE content.documents ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;
