-- Drop orphaned agent_version_id column from chat.conversations.
-- The referenced agent.agent_versions table was dropped in 0024; this column
-- became a dangling dead reference with no corresponding Drizzle definition.

ALTER TABLE chat.conversations DROP COLUMN IF EXISTS agent_version_id;
