-- Backfill the role grants for the operator and work order metrics (F33,
-- #5087), and for spend per merged PR, which F26 (#5042) shipped without a
-- backfill.
--
-- An enterprise org reads its permissions from iam.role_grants, which
-- bootstrapOrgIAM (packages/handlers/src/iam-provision.ts) fills once, when
-- the org is created. A contract added later reaches new orgs only, and the
-- production migration path runs `atlas migrate apply` and nothing else. So
-- without this migration an org Admin in an enterprise org that existed
-- before these contracts is refused both by the kernel's default deny.
--
-- The rows below are the contracts' defaultRoles:
--   get_work_order_metrics   org Owner, org Admin (the ranking's readers)
--   get_spend_per_merged_pr  org Owner, Admin, Billing, Member;
--                            workspace Owner, Member (as get_spend)
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
-- iam.role_grants forces row level security. The production connection
-- already sets app.rls_bypass. The set_config call below makes a local
-- migration run behave the same way, and its scope ends with this file's
-- transaction.

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
    ('org', 'Owner', 'get_work_order_metrics'),
    ('org', 'Admin', 'get_work_order_metrics'),
    ('org', 'Owner', 'get_spend_per_merged_pr'),
    ('org', 'Admin', 'get_spend_per_merged_pr'),
    ('org', 'Billing', 'get_spend_per_merged_pr'),
    ('org', 'Member', 'get_spend_per_merged_pr'),
    ('workspace', 'Owner', 'get_spend_per_merged_pr'),
    ('workspace', 'Member', 'get_spend_per_merged_pr')
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
