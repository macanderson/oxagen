-- Organization: one custom role per name in an org (issue #2964; ADR-063).
--
-- `roles_org_scope_name_uq` (20260915140000) keys names per scope kind, which
-- admits a custom org role and a custom workspace role of the same name.
-- `assign_agent_role`, `revoke_agent_role` and `get_agent_role` take a role
-- name with no scope and resolve it with one unordered row
-- (packages/agent/src/handlers/_agent-role.ts, `resolveRoleByName`), so such a
-- pair would bind or revoke whichever row Postgres returned first. Custom
-- names are therefore unique across both scope kinds. Seeded roles keep the
-- per-scope-kind key: the seed carries an org "Owner" and a workspace "Owner",
-- and `create_role`'s lower-case name pattern never produces a seeded name
-- exactly, so the name lookup cannot confuse a custom role with a seeded one.
CREATE UNIQUE INDEX "roles_org_custom_name_uq"
  ON "iam"."roles" USING btree ("org_id", lower("name"))
  WHERE NOT "is_system_default";
