-- Backfill the mandate grants that #3440 (ADR-107, issue #3138) added to
-- three contracts' defaultRoles.
--
-- An enterprise org reads its permissions from iam.role_grants, which
-- bootstrapOrgIAM (packages/handlers/src/iam-provision.ts) fills once, when
-- the org is created. A later change to a contract's defaultRoles reaches new
-- orgs only. The production migration path (infra/tools/run-db-migrations.sh)
-- runs `atlas migrate apply` and nothing else, so it never runs
-- `pnpm db:seed-iam`. Without this migration, a workspace Owner or Member in an
-- enterprise org that existed before #3440 still cannot read the mandate draft
-- they just requested.
--
-- The rows below are the grants that #3440 added:
--   list_mandates    workspace Owner, workspace Member
--   get_mandate      workspace Owner, workspace Member
--   request_mandate  org Billing, org Compliance
-- The org Owner and Admin grants on all three capabilities, and the workspace
-- Owner and Member grants on request_mandate, predate #3440, so provisioning
-- already wrote them. #3440 also removed an org "Member" grant. No org has a
-- system org role of that name, so that grant never produced a row and there
-- is nothing to delete.
--
-- Each row matches what bootstrapOrgIAM and tools/scripts/seed-iam-defaults.ts
-- write for the same grant, including the public id:
-- rlg_ followed by the first 24 hex characters of sha256('<role_id>:<capability_id>').
-- A later `pnpm db:seed-iam` run therefore finds the row and skips it.
--
-- Idempotent. ON CONFLICT DO NOTHING skips a public id that already exists.
-- The NOT EXISTS clause skips any role that already holds a grant on the same
-- capability, whatever its effect, so an org's own explicit deny survives.
--
-- It covers every org that holds the system roles, not only enterprise orgs.
-- That matches provisioning, which seeds grants for every org, and a
-- non-enterprise org never reads them (checkIAM allows before it looks).
--
-- iam.role_grants forces row level security. The production connection
-- already sets app.rls_bypass (run-db-migrations.sh). The set_config call
-- below makes a local `pnpm db:migrate` behave the same way, and its scope
-- ends with this file's transaction.

SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO "iam"."role_grants" (
  "public_id",
  "org_id",
  "role_id",
  "capability_id",
  "effect"
)
SELECT
  'rlg_' || substr(encode(sha256(convert_to(r."id"::text || ':' || g.capability_id, 'UTF8')), 'hex'), 1, 24),
  r."org_id",
  r."id",
  g.capability_id,
  'allow'
FROM "iam"."roles" AS r
JOIN (
  VALUES
    ('workspace', 'Owner', 'list_mandates'),
    ('workspace', 'Member', 'list_mandates'),
    ('workspace', 'Owner', 'get_mandate'),
    ('workspace', 'Member', 'get_mandate'),
    ('org', 'Billing', 'request_mandate'),
    ('org', 'Compliance', 'request_mandate')
) AS g(scope_kind, role_name, capability_id)
  ON r."scope_kind" = g.scope_kind
 AND r."name" = g.role_name
WHERE r."is_system_default" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "iam"."role_grants" AS existing
    WHERE existing."role_id" = r."id"
      AND existing."capability_id" = g.capability_id
  )
ON CONFLICT DO NOTHING;
