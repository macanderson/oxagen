-- 0008_iam_seed_defaults.sql
--
-- OXA-1389: Phase 2 — IAM system role seeds.
--
-- Seeds 4 org-level + 3 workspace-level system roles for every existing org
-- and workspace. All inserts are idempotent (ON CONFLICT DO NOTHING).
--
-- System roles are identified by their (org_id, scope_kind, name) triple.
-- They are not tied to a specific UUID — the seed generates a stable v4 UUID
-- per org so re-running is safe.
--
-- role_grants rows (capability → role mappings) are seeded by the separate
-- TypeScript script tools/scripts/seed-iam-defaults.ts (run via
-- `pnpm db:seed-iam`) because they depend on each contract's `defaultRoles`
-- field, which cannot be read from SQL.
--
-- Down migration (documented, not run):
--   DELETE FROM org.roles WHERE is_system_default = 'true';

------------------------------------------------------------
-- Org-level system roles (4 per org)
------------------------------------------------------------

-- Owner: full control over the org.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'owner',
  o.id,
  'org',
  'Owner',
  'Full administrative control over the organisation',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

-- Admin: manage users and settings, but cannot delete the org.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'admin',
  o.id,
  'org',
  'Admin',
  'Manage users, settings, and workspaces; cannot delete the org',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

-- Compliance: read-only access to audit logs and compliance reports.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'compliance',
  o.id,
  'org',
  'Compliance',
  'Read-only access to audit events and compliance evidence',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

-- Billing: manage billing, invoices, and credit purchases.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'billing',
  o.id,
  'org',
  'Billing',
  'Manage billing details, invoices, and credit purchases',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

------------------------------------------------------------
-- Workspace-level system roles (3 per org — workspace-scoped)
------------------------------------------------------------

-- Workspace Owner: full control over a workspace.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'wsowner',
  o.id,
  'workspace',
  'Owner',
  'Full control over a workspace — members, skills, agents, settings',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

-- Workspace Member: read/write within a workspace.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'wsmember',
  o.id,
  'workspace',
  'Member',
  'Read/write access within the workspace; cannot manage members',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;

-- Workspace Viewer: read-only within a workspace.
INSERT INTO org.roles (id, public_id, org_id, scope_kind, name, description, is_system_default, version)
SELECT
  gen_random_uuid(),
  'rol_' || lower(replace(cast(o.id as text), '-', '')) || 'wsviewer',
  o.id,
  'workspace',
  'Viewer',
  'Read-only access to workspace resources; no execution or write access',
  'true',
  '1'
FROM org.organizations o
ON CONFLICT DO NOTHING;
