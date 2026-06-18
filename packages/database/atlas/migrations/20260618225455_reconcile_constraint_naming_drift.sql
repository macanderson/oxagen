-- Drop index "registries_org_ws_default_uniq" from table: "registries"
DROP INDEX "mcp"."registries_org_ws_default_uniq";
-- Create index "registries_org_ws_default_uniq" to table: "registries"
CREATE UNIQUE INDEX "registries_org_ws_default_uniq" ON "mcp"."registries" ("org_id", "workspace_id") WHERE is_default;
-- Rename a constraint from "org_listings_pkey" to "installed_plugins_pkey"
ALTER TABLE "plugin"."installed_plugins" RENAME CONSTRAINT "org_listings_pkey" TO "installed_plugins_pkey";
-- Modify "installed_plugins" table
ALTER TABLE "plugin"."installed_plugins" DROP CONSTRAINT "org_listings_public_id_unique", ADD CONSTRAINT "installed_plugins_public_id_unique" UNIQUE ("public_id");
-- Modify "agent_triggers" table
ALTER TABLE "agent"."agent_triggers" DROP CONSTRAINT "agent_triggers_public_id_key", DROP CONSTRAINT "agent_triggers_agent_id_fkey", ADD CONSTRAINT "agent_triggers_public_id_unique" UNIQUE ("public_id"), ADD CONSTRAINT "agent_triggers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agent"."agents" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
