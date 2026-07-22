-- Provenance for the Markdown → canonical TOML skill backfill.
--
-- The TOML cutover made canonical `skill.toml` the stored form of
-- agent.skill_versions.body. Rows written before it hold Markdown with YAML
-- frontmatter, and every read path that calls canonicalizeSkillArtifact now
-- throws on them (skill.version.get, skill.export, skill.edit).
--
-- The backfill (tools/scripts/backfill-skill-toml.ts) rewrites `body` to
-- canonical TOML. skill_versions is otherwise an immutable, INSERT-only
-- snapshot table, so the pre-conversion bytes must not simply disappear:
--   - legacy_body:          the exact original body, preserved verbatim.
--   - legacy_body_checksum: SHA-256 hex over legacy_body, so the original can
--                           be proven byte-identical later even if the text
--                           column is ever pruned for size.
--   - migrated_at:          when the conversion ran.
--
-- All three are nullable. NULL legacy_body is the marker for "never converted",
-- which is what makes the backfill idempotent: a row that already carries
-- provenance is skipped, so a rerun can neither double-convert nor overwrite
-- the preserved original.
ALTER TABLE "agent"."skill_versions"
  ADD COLUMN IF NOT EXISTS "legacy_body" text NULL,
  ADD COLUMN IF NOT EXISTS "legacy_body_checksum" text NULL,
  ADD COLUMN IF NOT EXISTS "migrated_at" timestamptz NULL;

-- Partial index so the backfill can find unconverted rows without scanning
-- every version, and so operators can cheaply audit what was rewritten.
CREATE INDEX IF NOT EXISTS "skill_versions_migrated_idx"
  ON "agent"."skill_versions" ("migrated_at")
  WHERE "legacy_body" IS NOT NULL;
