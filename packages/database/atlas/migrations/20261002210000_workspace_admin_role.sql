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
-- Safe to run twice. The NOT EXISTS skips an org that already has a
-- workspace role named Admin in any casing, which is the key the unique index
-- roles_org_scope_name_uq enforces. ON CONFLICT DO NOTHING covers a row
-- written between the check and the insert. An org whose custom workspace
-- role already took the name keeps that role and gets no system Admin; the
-- permission checks never treat a custom role as Admin.
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
