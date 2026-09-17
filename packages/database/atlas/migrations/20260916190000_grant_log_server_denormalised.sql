-- ADR-071 (G2958 review): two fixes to the tool-governance lane.
--
-- 1. mcp.credential_grants names its server the way it already names its
--    connection. `mcp_server_id` carries no foreign key on purpose (the server
--    row is hard-deleted by plugin uninstall and the log has to outlive it),
--    so `list_credential_grants` LEFT JOINed and threw on a missing row. One
--    orphan on the newest-first first page made the grants log — an audit
--    surface — permanently unreadable for that workspace. The connection was
--    already denormalised at mint time for exactly this reason; the server now
--    is too.
--
-- 2. The gateway's kill-switch gate reloads its classification index only when
--    the deny generation moves. The existing trigger fires on a classification
--    change alone, so a version published with DECLARED consequence tags
--    (agent.tool_versions.consequence_tags, what publish_tool_declaration and
--    import_tools write) moved no generation and a class kill switch flipped
--    on mid-turn did not reach it. The trigger now covers both halves of the
--    tags, on insert as well as update.

-- ── 1. mcp.credential_grants: the server, named at mint time ─────────────────
ALTER TABLE "mcp"."credential_grants"
  ADD COLUMN "mcp_server_public_id" citext NULL,
  ADD COLUMN "mcp_server_name" text NULL;

UPDATE "mcp"."credential_grants" AS g
   SET "mcp_server_public_id" = s."public_id",
       "mcp_server_name" = s."name"
  FROM "mcp"."mcp_servers" AS s
 WHERE s."id" = g."mcp_server_id";

-- A grant whose server row is already gone is the row that used to throw.
-- It keeps its place in the log under a name that says what happened.
UPDATE "mcp"."credential_grants"
   SET "mcp_server_public_id" = COALESCE("mcp_server_public_id", 'mcs_deleted'),
       "mcp_server_name" = COALESCE("mcp_server_name", '(server deleted)')
 WHERE "mcp_server_public_id" IS NULL OR "mcp_server_name" IS NULL;

ALTER TABLE "mcp"."credential_grants"
  ALTER COLUMN "mcp_server_public_id" SET NOT NULL,
  ALTER COLUMN "mcp_server_name" SET NOT NULL;

COMMENT ON COLUMN "mcp"."credential_grants"."mcp_server_public_id" IS
  'The server''s mcs_… public id at mint time. mcp_server_id has no FK because plugin uninstall hard-deletes the server row; the log keeps naming what the credential reached.';
COMMENT ON COLUMN "mcp"."credential_grants"."mcp_server_name" IS
  'The server''s name at mint time, for the same reason.';

-- ── 2. Declared consequence tags move the deny generation ────────────────────
DROP TRIGGER IF EXISTS "tool_versions_classification_deny_generation"
  ON "agent"."tool_versions";
CREATE TRIGGER "tool_versions_classification_deny_generation"
  AFTER UPDATE OF "classification", "consequence_tags" ON "agent"."tool_versions"
  FOR EACH ROW
  WHEN (OLD.classification IS DISTINCT FROM NEW.classification
        OR OLD.consequence_tags IS DISTINCT FROM NEW.consequence_tags)
  EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

-- Publishing a new version is an INSERT, not an update of either column, so
-- the update trigger never saw a tool arriving already tagged. A version that
-- lands carrying tags of either half bumps the generation, and the gate
-- reloads its index at the next call boundary.
DROP TRIGGER IF EXISTS "tool_versions_tags_insert_deny_generation"
  ON "agent"."tool_versions";
CREATE TRIGGER "tool_versions_tags_insert_deny_generation"
  AFTER INSERT ON "agent"."tool_versions"
  FOR EACH ROW
  WHEN (NEW.classification IS NOT NULL
        OR COALESCE(array_length(NEW.consequence_tags, 1), 0) > 0)
  EXECUTE FUNCTION "iam"."deny_generation_scoped_trigger"();

-- ── 3. The category filter's two halves are index lookups ────────────────────
-- list_tool_versions filters the registry by consequence tag, and a tag lives
-- in either half. Without these, the Tools page's category filter sequentially
-- scanned every version in the workspace.
CREATE INDEX IF NOT EXISTS "tool_versions_classification_tags_gin"
  ON "agent"."tool_versions" USING gin (("classification" -> 'consequenceTags') jsonb_path_ops);
CREATE INDEX IF NOT EXISTS "tool_versions_consequence_tags_gin"
  ON "agent"."tool_versions" USING gin ("consequence_tags");
