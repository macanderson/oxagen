-- Backfill the role grants for the operator ranking, its pseudonym setting,
-- and the unproductive spend headline (#4574 item 4, #4955).
--
-- An enterprise org reads its permissions from iam.role_grants, which
-- bootstrapOrgIAM (packages/handlers/src/iam-provision.ts) fills once, when
-- the org is created. A contract added later reaches new orgs only. The
-- production migration path (infra/tools/run-db-migrations.sh) runs
-- `atlas migrate apply` and nothing else, so it never runs
-- `pnpm db:seed-iam`. Without this migration, an org Admin in an enterprise
-- org that existed before #4541 is refused get_operator_ranking and
-- set_operator_pseudonyms by the kernel's default deny, and every member of
-- such an org is refused get_unproductive_spend.
--
-- The rows below are the contracts' defaultRoles:
--   get_operator_ranking     org Owner, org Admin
--   set_operator_pseudonyms  org Owner, org Admin
--   get_unproductive_spend   org Owner, Admin, Billing, Member;
--                            workspace Owner, Member (as list_findings)
-- No workspace role reads the ranking: no person holds a workspace IAM role
-- yet (#3198), and the handler names org roles only.
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
    ('org', 'Owner', 'get_operator_ranking'),
    ('org', 'Admin', 'get_operator_ranking'),
    ('org', 'Owner', 'set_operator_pseudonyms'),
    ('org', 'Admin', 'set_operator_pseudonyms'),
    ('org', 'Owner', 'get_unproductive_spend'),
    ('org', 'Admin', 'get_unproductive_spend'),
    ('org', 'Billing', 'get_unproductive_spend'),
    ('org', 'Member', 'get_unproductive_spend'),
    ('workspace', 'Owner', 'get_unproductive_spend'),
    ('workspace', 'Member', 'get_unproductive_spend')
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
