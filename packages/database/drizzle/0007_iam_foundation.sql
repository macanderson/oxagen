-- 0007_iam_foundation.sql
--
-- OXA-1389: Phase 2 — IAM data layer.
--
-- Creates 7 IAM tables in the `org` Postgres schema. No `capability_registry`
-- table — capability metadata lives on contract objects, discovered at runtime.
-- All tables use the uuidv7 COALESCE DEFAULT pattern from the billing migration.
--
-- Idempotent: all DDL uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--
-- Down migration (documented, not run — pre-launch, forward-only policy):
--   DROP TABLE IF EXISTS org.iam_sessions;
--   DROP TABLE IF EXISTS org.access_requests;
--   DROP TABLE IF EXISTS org.policies;
--   DROP TABLE IF EXISTS org.grants;
--   DROP TABLE IF EXISTS org.role_grants;
--   DROP TABLE IF EXISTS org.roles;
--   DROP TABLE IF EXISTS org.principals;

------------------------------------------------------------
-- 1. org.principals — every human, agent, or service
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.principals (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  -- Org scope — all principals belong to exactly one org.
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  -- Workspace scope — nullable; a principal may be org-level only.
  workspace_id uuid,
  -- CHECK: kind IN ('human','agent','service')
  kind text NOT NULL,
  display_name text NOT NULL,
  -- CHECK: status IN ('active','suspended','deleted')
  status text NOT NULL DEFAULT 'active',
  mfa_status text NOT NULL DEFAULT 'none',
  idp_subject text,
  parent_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  -- CHECK constraints mirror the TypeScript types.
  CONSTRAINT principals_kind_check CHECK (kind IN ('human', 'agent', 'service')),
  CONSTRAINT principals_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE INDEX IF NOT EXISTS principals_org_kind_idx ON org.principals (org_id, kind);
CREATE INDEX IF NOT EXISTS principals_workspace_idx ON org.principals (workspace_id);
CREATE INDEX IF NOT EXISTS principals_idp_subject_idx ON org.principals (idp_subject);

------------------------------------------------------------
-- 2. org.roles — role definitions, system + custom, versioned
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.roles (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  -- CHECK: scope_kind IN ('org','workspace')
  scope_kind text NOT NULL,
  name text NOT NULL,
  description text,
  -- 'true' for system-seeded roles (not user-deletable).
  is_system_default text NOT NULL DEFAULT 'false',
  version text NOT NULL DEFAULT '1',
  parent_role_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT roles_scope_kind_check CHECK (scope_kind IN ('org', 'workspace'))
);

CREATE INDEX IF NOT EXISTS roles_org_name_idx ON org.roles (org_id, name);

------------------------------------------------------------
-- 3. org.role_grants — role → capability mapping
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.role_grants (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  role_id uuid NOT NULL REFERENCES org.roles(id),
  -- Capability string (e.g. "organization.create") — not a FK; capability
  -- metadata lives on contract objects, not a DB table.
  capability_id text NOT NULL,
  -- CHECK: effect IN ('allow','deny','require_approval')
  effect text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT role_grants_effect_check CHECK (effect IN ('allow', 'deny', 'require_approval'))
);

-- Hot path: "what effect does this role have on capability X?"
CREATE INDEX IF NOT EXISTS role_grants_role_capability_idx ON org.role_grants (role_id, capability_id);
CREATE INDEX IF NOT EXISTS role_grants_org_idx ON org.role_grants (org_id);

------------------------------------------------------------
-- 4. org.grants — direct principal → capability grants
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.grants (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  principal_id uuid NOT NULL REFERENCES org.principals(id),
  capability_id text NOT NULL,
  -- CHECK: scope_kind IN ('org','workspace')
  scope_kind text NOT NULL,
  scope_id uuid NOT NULL,
  -- CHECK: effect IN ('allow','deny','require_approval')
  effect text NOT NULL,
  conditions_jsonb jsonb,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT grants_effect_check CHECK (effect IN ('allow', 'deny', 'require_approval')),
  CONSTRAINT grants_scope_kind_check CHECK (scope_kind IN ('org', 'workspace'))
);

-- Resolver hot path: "what grants does principal X have in scope S?"
CREATE INDEX IF NOT EXISTS grants_principal_scope_idx ON org.grants (principal_id, scope_id);
CREATE INDEX IF NOT EXISTS grants_capability_idx ON org.grants (capability_id);

------------------------------------------------------------
-- 5. org.policies — conditional grants with enforcement flag
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.policies (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  name text NOT NULL,
  capability_id text NOT NULL,
  -- CHECK: scope_kind IN ('org','workspace')
  scope_kind text NOT NULL,
  scope_id uuid,
  -- CHECK: effect IN ('allow','deny','require_approval')
  effect text NOT NULL,
  -- 'true' when this policy is hard-enforced and cannot be overridden.
  enforced text NOT NULL DEFAULT 'false',
  conditions_jsonb jsonb,
  sensitivity_tag text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT policies_effect_check CHECK (effect IN ('allow', 'deny', 'require_approval')),
  CONSTRAINT policies_scope_kind_check CHECK (scope_kind IN ('org', 'workspace'))
);

CREATE INDEX IF NOT EXISTS policies_org_capability_idx ON org.policies (org_id, capability_id);

------------------------------------------------------------
-- 6. org.access_requests — JIT access requests
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.access_requests (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  requester_id uuid NOT NULL REFERENCES org.principals(id),
  capability_id text NOT NULL,
  -- CHECK: scope_kind IN ('org','workspace')
  scope_kind text NOT NULL,
  scope_id uuid NOT NULL,
  -- CHECK: status IN ('pending','approved','denied','expired')
  status text NOT NULL DEFAULT 'pending',
  approver_id uuid,
  approved_at timestamptz,
  ttl_seconds text,
  justification text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  CONSTRAINT access_requests_status_check CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  CONSTRAINT access_requests_scope_kind_check CHECK (scope_kind IN ('org', 'workspace'))
);

CREATE INDEX IF NOT EXISTS access_requests_requester_idx ON org.access_requests (requester_id);
CREATE INDEX IF NOT EXISTS access_requests_org_status_idx ON org.access_requests (org_id, status);

------------------------------------------------------------
-- 7. org.iam_sessions — principal session lifecycle
--
-- APPEND-LEANING: no updated_at / updated_by columns. Revocation tracked via
-- revoked_at + revoked_by. Named iam_sessions to avoid collision with
-- auth.sessions.
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org.iam_sessions (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  public_id citext NOT NULL UNIQUE,
  org_id uuid NOT NULL REFERENCES org.organizations(id),
  principal_id uuid NOT NULL REFERENCES org.principals(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  ip text,
  ua text,
  idp_session_id text,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid
  -- NOTE: No updated_at / updated_by — sessions are append-leaning. SOC2 CC6.
);

-- Resolver hot path: "is this principal's session still active?"
CREATE INDEX IF NOT EXISTS iam_sessions_principal_idx ON org.iam_sessions (principal_id);
CREATE INDEX IF NOT EXISTS iam_sessions_org_idx ON org.iam_sessions (org_id);
