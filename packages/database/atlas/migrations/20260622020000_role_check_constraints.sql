-- Role CHECK constraints on the three membership/invitation columns
-- (perf/db-schema-audit, P2 data-integrity fix).
--
-- org.org_users.role, workspace.workspace_users.role, and org.invitations.role
-- were bare text with no constraint, yet app code compares them against a fixed
-- role set. The DB could not reject a typo'd or garbage role — the exact shape
-- of the org-role-casing bug that silently broke GDPR org-erasure.
--
-- CASE-INSENSITIVE membership is required: these columns legitimately hold BOTH
-- casings today. Lowercase is written by the org/workspace create + onboarding
-- paths (role:'owner'); Capitalized is written by workspace.invite.send's
-- mapRole() (Member/Admin/Owner), org.member.invite.accept (copies the
-- Title-cased invitation.role into org_users.role), and the IAM-role-name path
-- in org.member.role.change (Owner/Admin). A case-sensitive lowercase-only
-- CHECK would reject those writes and turn a P2 into a P0. So the constraint
-- asserts lower(role) ∈ the canonical name set, which rejects garbage without
-- breaking any current writer.
--
-- The role names are a FIXED seeded set — there is no custom-role-creation
-- path. From iam-provision.ts: ORG_ROLES = Owner/Admin/Compliance/Billing,
-- WORKSPACE_ROLES = Owner/Member/Viewer. The lowercase union is:
--   owner, admin, member, billing, compliance, viewer
--
-- NOT VALID is intentionally NOT used: the constraint is added as fully
-- validated so it scans existing rows now (these tables are small) and any
-- pre-existing bad row surfaces immediately at migration time rather than
-- lurking. Verified: local data has 0 violations.

ALTER TABLE "org"."org_users"
  ADD CONSTRAINT "org_users_role_check"
  CHECK (lower(role) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer'));

ALTER TABLE "workspace"."workspace_users"
  ADD CONSTRAINT "workspace_users_role_check"
  CHECK (lower(role) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer'));

ALTER TABLE "org"."invitations"
  ADD CONSTRAINT "invitations_role_check"
  CHECK (lower(role) IN ('owner', 'admin', 'member', 'billing', 'compliance', 'viewer'));
