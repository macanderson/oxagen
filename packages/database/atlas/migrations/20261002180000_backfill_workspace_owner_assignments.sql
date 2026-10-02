-- Give every existing workspace owner the workspace Owner role in IAM, and
-- let that role read the operator ranking (#5182).
--
-- A workspace's creator is recorded in workspace.workspace_users with role
-- owner. Permission checks read iam.principal_role_assignments instead
-- (assertOrgRole in packages/iam/src/org-role.ts, and the kernel's
-- fetch-authz.ts). Workspace creation wrote no assignment there, so every
-- workspace: ["Owner"] clause in a contract refused the owner. bootstrapWorkspace
-- (packages/handlers/src/workspace-bootstrap.ts) now writes the assignment
-- when a workspace is created. The first statement below writes the same row
-- for each workspace that already exists.
--
-- It writes one row for each workspace_users row with role owner, in either
-- casing, whose user has an active human principal in the workspace's org.
-- The row holds that principal, the org's workspace-scoped Owner role, and
-- the workspace id. The assignment grants Owner on that one workspace only.
-- A user with no active principal gets no row: the permission check reads
-- only active principals, so the row would grant nothing.
--
-- The public id is pra_ followed by the first 22 hex characters of
-- sha256('<principal_id>:<role_id>:<workspace_id>'), so a run writes the same
-- id for the same assignment.
--
-- The second statement grants the workspace Owner role an allow on
-- get_operator_ranking. The contract's defaultRoles now name that role.
-- bootstrapOrgIAM seeds role grants once, when an org is created, so an org
-- that already exists needs this row for the kernel to admit a workspace
-- Owner in an Enterprise org. The row matches what bootstrapOrgIAM and
-- tools/scripts/seed-iam-defaults.ts write for the same grant, including the
-- public id: rlg_ followed by the first 24 hex characters of
-- sha256('<role_id>:<capability_id>').
--
-- Safe to run twice. The first statement's ON CONFLICT names the partial
-- unique index pra_principal_role_org_workspace_idx, so it skips an
-- assignment that already exists. That includes one marked deleted, so a
-- revoked assignment stays revoked. The second statement skips any role that
-- already holds a grant on the capability, whatever its effect, so an org's
-- own explicit deny survives.
--
-- Both tables force row level security. The production connection already
-- sets app.rls_bypass (infra/tools/run-db-migrations.sh). The set_config call
-- below makes a local `pnpm db:migrate` behave the same way, and its scope
-- ends with this file's transaction.

SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO "iam"."principal_role_assignments" (
  "public_id",
  "principal_id",
  "role_id",
  "org_id",
  "workspace_id",
  "assigned_by",
  "created_by_id",
  "updated_by_id"
)
SELECT
  'pra_' || substr(encode(sha256(convert_to(p."id"::text || ':' || r."id"::text || ':' || w."id"::text, 'UTF8')), 'hex'), 1, 22),
  p."id",
  r."id",
  w."org_id",
  w."id",
  wu."user_id",
  wu."user_id",
  wu."user_id"
FROM "workspace"."workspace_users" AS wu
JOIN "workspace"."workspaces" AS w
  ON w."id" = wu."workspace_id"
JOIN "iam"."principals" AS p
  ON p."org_id" = w."org_id"
 AND p."parent_user_id" = wu."user_id"
 AND p."kind" = 'human'
 AND p."status" = 'active'
JOIN "iam"."roles" AS r
  ON r."org_id" = w."org_id"
 AND r."scope_kind" = 'workspace'
 AND r."name" = 'Owner'
WHERE lower(wu."role") = 'owner'
ON CONFLICT ("principal_id", "role_id", "org_id", "workspace_id")
  WHERE "workspace_id" IS NOT NULL
  DO NOTHING;

INSERT INTO "iam"."role_grants" (
  "public_id",
  "org_id",
  "role_id",
  "capability_id",
  "effect"
)
SELECT
  'rlg_' || substr(encode(sha256(convert_to(r."id"::text || ':' || 'get_operator_ranking', 'UTF8')), 'hex'), 1, 24),
  r."org_id",
  r."id",
  'get_operator_ranking',
  'allow'
FROM "iam"."roles" AS r
WHERE r."scope_kind" = 'workspace'
  AND r."name" = 'Owner'
  AND r."is_system_default" = true
  AND NOT EXISTS (
    SELECT 1
    FROM "iam"."role_grants" AS existing
    WHERE existing."role_id" = r."id"
      AND existing."capability_id" = 'get_operator_ranking'
  )
ON CONFLICT DO NOTHING;
