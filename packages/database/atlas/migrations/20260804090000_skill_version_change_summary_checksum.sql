-- Skill version lineage + integrity metadata (skills detail/versioning repair).
--
-- skill_versions rows are immutable snapshots (INSERT-only), but two pieces of
-- metadata had nowhere to land at creation time:
--   - change_summary: the author-supplied commit message. The skill detail UI
--     collects one on every edit, and skill.version.upload now accepts it.
--   - checksum: SHA-256 hex over `body` — the same immutability contract
--     agent_versions.checksum establishes for agent config snapshots. Needed
--     so a historical version can be proven byte-identical later (usage
--     traceability / metering disputes).
-- Both nullable: rows created before this migration carry neither.
ALTER TABLE "agent"."skill_versions"
  ADD COLUMN IF NOT EXISTS "change_summary" text NULL,
  ADD COLUMN IF NOT EXISTS "checksum" text NULL;
