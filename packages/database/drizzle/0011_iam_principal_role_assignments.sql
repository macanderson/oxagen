-- 0011_iam_principal_role_assignments.sql
--
-- OXA-1498: Add org.principal_role_assignments — maps a principal to a role
-- within an org (and optionally workspace) scope.  This table replaces the
-- prior "grant everyone every role" shortcut in the IAM resolver.
--
-- Design notes:
--   • One row per (principal, role, org, workspace) tuple — the unique index
--     enforces idempotent upserts from the IAM service.
--   • workspace_id NULL = org-wide assignment.  Because standard UNIQUE treats
--     NULLs as distinct, we use a separate partial unique index to close the
--     gap for org-wide (workspace_id IS NULL) assignments.
--   • Soft-delete (deleted_at / deleted_by_user_id) for audit trail; hard
--     DELETE is prohibited on org-scoped tables per policy.
--   • Optional expires_at for time-bounded (JIT) role assignments.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- Down migration (documented, not run automatically):
--   DROP TABLE IF EXISTS org.principal_role_assignments;

CREATE TABLE IF NOT EXISTS org.principal_role_assignments (
  id                  UUID        NOT NULL PRIMARY KEY DEFAULT COALESCE(
                                    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                      THEN uuid_generate_v7()
                                      ELSE uuid_generate_v4()
                                    END,
                                    uuid_generate_v4()
                                  ),
  public_id           CITEXT      NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id  UUID,
  updated_by_user_id  UUID,
  deleted_at          TIMESTAMPTZ,
  deleted_by_user_id  UUID,

  -- The subject being assigned a role.
  principal_id        UUID        NOT NULL REFERENCES org.principals(id),
  -- The role being assigned.
  role_id             UUID        NOT NULL REFERENCES org.roles(id),
  -- Org this assignment lives in.
  org_id              UUID        NOT NULL REFERENCES org.organizations(id),
  -- Optional workspace scope. NULL = org-wide assignment.
  workspace_id        UUID,
  -- Audit: who performed the assignment.
  assigned_by         UUID,
  assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optional expiry for time-bounded role assignments (JIT access).
  expires_at          TIMESTAMPTZ
);

-- Unique index for workspace-scoped assignments (workspace_id NOT NULL).
CREATE UNIQUE INDEX IF NOT EXISTS pra_principal_role_org_workspace_idx
  ON org.principal_role_assignments (principal_id, role_id, org_id, workspace_id)
  WHERE workspace_id IS NOT NULL;

-- Partial unique index for org-wide assignments (workspace_id IS NULL).
-- Standard UNIQUE treats NULLs as distinct; this closes the gap so two
-- org-wide (principal, role, org) assignments are correctly rejected.
CREATE UNIQUE INDEX IF NOT EXISTS pra_principal_role_org_null_workspace_idx
  ON org.principal_role_assignments (principal_id, role_id, org_id)
  WHERE workspace_id IS NULL;

-- Find all roles assigned to a principal in an org (resolver hot path).
CREATE INDEX IF NOT EXISTS pra_principal_org_idx
  ON org.principal_role_assignments (principal_id, org_id);

-- Find all principals assigned to a role.
CREATE INDEX IF NOT EXISTS pra_role_org_idx
  ON org.principal_role_assignments (role_id, org_id);

-- Resolve workspace-scoped assignments quickly.
CREATE INDEX IF NOT EXISTS pra_workspace_idx
  ON org.principal_role_assignments (workspace_id);
