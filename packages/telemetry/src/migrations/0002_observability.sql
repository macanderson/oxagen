-- Observability columns.
-- token_usage: provider, duration_ms, surface, prompt_hash, workspace_id.
-- tool_invocations: surface, provider.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS provider LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS duration_ms UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surface LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS prompt_hash String DEFAULT '',
  ADD COLUMN IF NOT EXISTS workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS surface LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS provider LowCardinality(String) DEFAULT '';
