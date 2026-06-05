-- 0009_conversation_archive_soft_delete.sql
--
-- Give chat.conversations a reversible archive state and soft-delete columns
-- so the workspace conversation-history nav can archive (reversible, hidden
-- from the active list) and delete (engineering-policy soft-delete: the row is
-- retained for SOC2/audit but disappears from every list and is not restorable
-- through the UI). Mirrors 0007_content_soft_delete.sql.
--
-- Additive + nullable, no backfill (existing rows are active + non-deleted).
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) so it is
-- safe on a partially-applied database.
ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;
ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS archived_by_user_id uuid;
ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;

-- Serves the history-nav scan: (workspace_id, user_id, deleted_at, archived_at)
-- filter then updated_at-desc read, no sort step.
CREATE INDEX IF NOT EXISTS conversations_list_idx
  ON chat.conversations
  USING btree (workspace_id, user_id, deleted_at, archived_at, updated_at);
