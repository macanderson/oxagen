-- mcp.server_discoveries.source_registry_name and source_version: the
-- registry name and version of a registry server (M10, #4682).
--
-- Each discovery run writes both from the server's server.toml on the
-- steering repository's main, next to the other source columns. The hourly
-- discovery sweep joins source_registry_name to mcp.catalog_servers in the
-- same workspace. When the catalog's newest entry names a version other than
-- the one discovery last saw (latest_version, or source_version before any
-- run read the catalog), the sweep asks for a `registry_version` discovery.
-- Every other source kind writes null to both.
--
-- Both columns are nullable with no default, so the ALTER rewrites no row
-- and takes an ACCESS EXCLUSIVE lock on mcp.server_discoveries for the
-- catalog change only. No backfill: the next discovery of each registry
-- server fills them, and the sweep skips a row until then.
--
-- No table is created, so the tenant policies and grants stay as they are.
--
-- Hand-written, then `atlas migrate hash`.
--
-- Rollback:
--   ALTER TABLE mcp.server_discoveries DROP COLUMN source_registry_name;
--   ALTER TABLE mcp.server_discoveries DROP COLUMN source_version;
--   Only discovery's recordSource and the sweep's registry query use the
--   columns, so the previous code runs unchanged after a rollback.

ALTER TABLE "mcp"."server_discoveries"
  ADD COLUMN IF NOT EXISTS "source_registry_name" text;

ALTER TABLE "mcp"."server_discoveries"
  ADD COLUMN IF NOT EXISTS "source_version" text;

COMMENT ON COLUMN "mcp"."server_discoveries"."source_registry_name" IS
  'A registry server''s source.server, the name mcp.catalog_servers lists it by. Null for every other source kind.';

COMMENT ON COLUMN "mcp"."server_discoveries"."source_version" IS
  'A registry server''s source.version on the steering repository''s main. Null for every other source kind.';
