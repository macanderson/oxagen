-- Give every organization the workspace Admin role (#5228).
--
-- A workspace's Owner and Admin can do everything in that workspace. The
-- workspace roles used to be Owner, Member and Viewer, so Admin is new.
-- bootstrapOrgIAM (packages/handlers/src/iam-provision.ts) now writes the
-- role when it creates an org. This migration writes the same row for every
-- org that already exists.
--
-- Nobody holds the role yet. Workspace membership will assign it (#3198).
-- The permission checks already admit it. Rule 7.6 of the resolver
-- (packages/oxagen/src/iam/resolve.ts) reads the role by name, scope and the
-- is_system_default flag. assertOrgRole (packages/iam/src/org-role.ts) reads
-- it by name and scope.
--
-- The row matches what bootstrapOrgIAM writes, including the public id:
-- rol_ followed by the first 22 hex characters of
-- sha256('<org_id>:workspace:Admin').
--
-- The second statement gives the role the two role grants bootstrapOrgIAM
-- seeds for it from contracts that name the workspace Admin role and are
-- org-level, so rule 7.6 does not reach them: get_org_settings and
-- get_spend_budget, both allow. An Enterprise org reads role grants, so
-- without these rows an existing org's workspace Admin would be refused two
-- reads a new org's is allowed. The public id is rlg_ followed by the first 24
-- hex characters of sha256('<role_id>:<capability_id>'), as bootstrapOrgIAM
-- and tools/scripts/seed-iam-defaults.ts write it.
--
-- Safe to run twice. The first NOT EXISTS skips an org that already has a
-- workspace role named Admin in any casing, which is the key the unique index
-- roles_org_scope_name_uq enforces. ON CONFLICT DO NOTHING covers a row
-- written between the check and the insert. An org whose custom workspace
-- role already took the name keeps that role and gets no system Admin; the
-- permission checks never treat a custom role as Admin. The second NOT EXISTS
-- skips a role that already holds a grant on the capability, whatever its
-- effect, so an org's own explicit deny survives.
--
-- iam.roles forces row level security. The production connection already
-- sets app.rls_bypass (infra/tools/run-db-migrations.sh). The set_config call
-- below makes a local `pnpm db:migrate` behave the same way, and its scope
-- ends with this file's transaction.

SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO "iam"."roles" (
  "public_id",
  "org_id",
  "scope_kind",
  "name",
  "is_system_default"
)
SELECT
  'rol_' || substr(encode(sha256(convert_to(o."id"::text || ':workspace:Admin', 'UTF8')), 'hex'), 1, 22),
  o."id",
  'workspace',
  'Admin',
  true
FROM "org"."organizations" AS o
WHERE NOT EXISTS (
  SELECT 1
  FROM "iam"."roles" AS existing
  WHERE existing."org_id" = o."id"
    AND existing."scope_kind" = 'workspace'
    AND lower(existing."name") = 'admin'
)
ON CONFLICT DO NOTHING;

INSERT INTO "iam"."role_grants" (
  "public_id",
  "org_id",
  "role_id",
  "capability_id",
  "effect"
)
SELECT
  'rlg_' || substr(encode(sha256(convert_to(r."id"::text || ':' || c."capability_id", 'UTF8')), 'hex'), 1, 24),
  r."org_id",
  r."id",
  c."capability_id",
  'allow'
FROM "iam"."roles" AS r
CROSS JOIN (VALUES ('get_org_settings'), ('get_spend_budget')) AS c ("capability_id")
WHERE r."scope_kind" = 'workspace'
  AND r."name" = 'Admin'
  AND r."is_system_default" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "iam"."role_grants" AS existing
    WHERE existing."role_id" = r."id"
      AND existing."capability_id" = c."capability_id"
  )
ON CONFLICT DO NOTHING;
