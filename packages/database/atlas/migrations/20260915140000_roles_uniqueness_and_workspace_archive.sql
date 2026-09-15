-- Organization: roles and workspaces (issue #2964; ADR-057).
--
-- iam.roles: one role of each name per scope kind in an org (#2158). The
-- seeded set carries an org "Owner" and a workspace "Owner", so the key is
-- (org_id, scope_kind, lower(name)) and never (org_id, name). A duplicate
-- already present makes this statement fail, which is the outcome wanted: a
-- duplicated system role is a provisioning defect to resolve by hand before
-- the constraint lands, never a row to drop blind.
CREATE UNIQUE INDEX "roles_org_scope_name_uq"
  ON "iam"."roles" USING btree ("org_id", "scope_kind", lower("name"));

-- workspace.workspaces: `archive_workspace` records who archived it and when.
-- NULL = active. The two columns move together.
ALTER TABLE "workspace"."workspaces"
  ADD COLUMN "archived_at" timestamptz,
  ADD COLUMN "archived_by_user_id" uuid,
  ADD CONSTRAINT "workspaces_archived_check"
    CHECK (("archived_at" IS NULL) = ("archived_by_user_id" IS NULL));
