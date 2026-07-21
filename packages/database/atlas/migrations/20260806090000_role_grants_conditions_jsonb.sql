-- Agent RBAC Phase 1 (docs/specs/agent-rbac/spec.md §3.3): iam.role_grants
-- gains a nullable conditions_jsonb column so a role_grant row can carry a
-- typed resourceScope ceiling (graph labels/relationship-types, MCP
-- "server:tool" glob rules, skill slugs, subagent refs) alongside its plain
-- capability -> effect mapping. packages/oxagen/src/iam/resolve.ts's
-- RoleGrant.conditionsJsonb and collectResourceScope() already read this
-- shape (landed ahead of this migration) but had no column to read it from
-- until now. tools/scripts/seed-iam-defaults.ts is the first writer, seeding
-- it for the three system agent roles (Agent Observer/Contributor/Operator).
ALTER TABLE "iam"."role_grants" ADD COLUMN "conditions_jsonb" jsonb;
