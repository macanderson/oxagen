-- M13 (#4478): the steering repo writes the tool registry. Four changes.
--
-- 1. mcp.mcp_servers records where a row came from. origin is steering when
--    publishing a steering version wrote the row, and legacy when a direct
--    path wrote it. steering_name is the server folder the row belongs to.
--    migrate() sets it on a legacy row, so the first publish after the
--    migration PR merges takes that row over and keeps its id, its tools and
--    their history. transport_type also admits openapi, graphql and grpc, the
--    three definition sources a server folder can name.
-- 2. mcp.credentials gains name, the <name> in oxagen:credential/<name>. It
--    is unique in a workspace. Existing rows take their installed plugin's
--    name, made lowercase with hyphens. A new row that names none gets
--    credential-<12 hex digits>, so the paths that insert a credential today
--    keep working.
-- 3. Consequence tags are called impacts. agent.tool_versions and
--    tools.mandates rename the column. The deny-generation triggers name the
--    column by number, so the rename carries over to them.
-- 4. A stored classification renames its consequenceTags key to impacts.
--    The update trigger is off while the key moves. The tags are the same,
--    so no gate needs to reload, and a reload by code that still reads the
--    old key would lose every classified tag until the new code deploys.
--
-- No table is created, so the tenant policies and grants stay as they are.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. mcp.mcp_servers: origin, steering_name, and three more transports.

ALTER TABLE "mcp"."mcp_servers"
  DROP CONSTRAINT IF EXISTS "mcp_servers_transport_type_check";
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_transport_type_check"
  CHECK ("transport_type" IN ('streamable-http', 'sse', 'stdio', 'openapi', 'graphql', 'grpc'));

ALTER TABLE "mcp"."mcp_servers"
  ADD COLUMN "origin" text NOT NULL DEFAULT 'legacy',
  ADD COLUMN "steering_name" text NULL;

ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_origin_check"
  CHECK ("origin" IN ('steering', 'legacy'));

-- The folder name's pattern from the steering-repo contract.
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_steering_name_check"
  CHECK ("steering_name" IS NULL OR "steering_name" ~ '^[a-z][a-z0-9_]{0,23}$');

-- A steering row always names its folder.
ALTER TABLE "mcp"."mcp_servers"
  ADD CONSTRAINT "mcp_servers_steering_origin_check"
  CHECK ("origin" <> 'steering' OR "steering_name" IS NOT NULL);

-- One live row per folder in a workspace.
CREATE UNIQUE INDEX "mcp_servers_ws_steering_name_uniq"
  ON "mcp"."mcp_servers" ("workspace_id", "steering_name")
  WHERE "steering_name" IS NOT NULL AND "deleted_at" IS NULL;

COMMENT ON COLUMN "mcp"."mcp_servers"."origin" IS
  'steering when publishing a steering version wrote the row; legacy when agent.mcp.register, a plugin install or import_tools wrote it. The in-app agent skips steering rows.';
COMMENT ON COLUMN "mcp"."mcp_servers"."steering_name" IS
  'The server folder under tools/servers/ in the steering repo. Set on a steering row, and on a legacy row the migration PR moves.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. mcp.credentials: name.

ALTER TABLE "mcp"."credentials" ADD COLUMN "name" text NULL;

-- The installed plugin's name, lowercase, with every other run of characters
-- turned into one hyphen and cut to 50 characters. A row whose plugin is gone
-- or whose name leaves nothing takes credential-<12 hex digits of its id>. A
-- second row in a workspace with the same name takes 8 hex digits of its id
-- as a suffix.
WITH "base" AS (
  SELECT c."id",
         c."workspace_id",
         COALESCE(
           NULLIF(
             trim(BOTH '-' FROM left(regexp_replace(lower(p."name"), '[^a-z0-9]+', '-', 'g'), 50)),
             ''
           ),
           'credential-' || left(replace(c."id"::text, '-', ''), 12)
         ) AS "slug"
    FROM "mcp"."credentials" AS c
    LEFT JOIN "plugin"."installed_plugins" AS p ON p."id" = c."org_listing_id"
), "ranked" AS (
  SELECT "id",
         "slug",
         row_number() OVER (PARTITION BY "workspace_id", "slug" ORDER BY "id") AS "n"
    FROM "base"
)
UPDATE "mcp"."credentials" AS c
   SET "name" = CASE
                  WHEN r."n" = 1 THEN r."slug"
                  ELSE r."slug" || '-' || left(replace(c."id"::text, '-', ''), 8)
                END
  FROM "ranked" AS r
 WHERE r."id" = c."id";

ALTER TABLE "mcp"."credentials"
  ALTER COLUMN "name" SET DEFAULT ('credential-' || left(replace(gen_random_uuid()::text, '-', ''), 12)),
  ALTER COLUMN "name" SET NOT NULL;

ALTER TABLE "mcp"."credentials"
  ADD CONSTRAINT "credentials_name_check"
  CHECK ("name" ~ '^[a-z0-9][a-z0-9-]{0,62}$');

CREATE UNIQUE INDEX "credentials_workspace_name_uniq"
  ON "mcp"."credentials" ("workspace_id", "name");

COMMENT ON COLUMN "mcp"."credentials"."name" IS
  'The <name> in oxagen:credential/<name>, the reference a steering server folder uses. Unique in a workspace.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. consequence_tags is called impacts.

ALTER TABLE "agent"."tool_versions" RENAME COLUMN "consequence_tags" TO "impacts";
ALTER INDEX "agent"."tool_versions_consequence_tags_gin" RENAME TO "tool_versions_impacts_gin";

COMMENT ON COLUMN "agent"."tool_versions"."impacts" IS
  'The impacts invoking this version can have (MC spec §6.9 part 1): moves_money, destroys_data, alters_production, communicates_externally, changes_access, changes_entitlement, or one a workspace defines.';

ALTER TABLE "tools"."mandates" RENAME COLUMN "consequence_tags" TO "impacts";

-- ════════════════════════════════════════════════════════════════════════════
-- 4. A stored classification's consequenceTags key is called impacts.

ALTER TABLE "agent"."tool_versions"
  DISABLE TRIGGER "tool_versions_classification_deny_generation";

UPDATE "agent"."tool_versions"
   SET "classification" = ("classification" - 'consequenceTags')
                          || jsonb_build_object('impacts', "classification" -> 'consequenceTags')
 WHERE "classification" ? 'consequenceTags';

ALTER TABLE "agent"."tool_versions"
  ENABLE TRIGGER "tool_versions_classification_deny_generation";

-- The registry's impact filter reads the classified half through this index.
DROP INDEX IF EXISTS "agent"."tool_versions_classification_tags_gin";
CREATE INDEX "tool_versions_classification_impacts_gin"
  ON "agent"."tool_versions" USING gin (("classification" -> 'impacts') jsonb_path_ops);
