-- Machine groups (mcp-studio-spec, Local servers, Machines).
--
-- 1. tacho.machine_group_members puts one enrolled machine in one named group.
--    A local server runs only on a machine whose group the server names, and
--    the cloud gateway reads these rows before it signs a local call envelope.
--    The columns, index and CHECK match packages/database/src/schema/
--    machine-groups.ts. host_id is a foreign key to tacho.hosts in the same
--    schema, so deleting a host deletes its memberships. The table is
--    tenant-isolated like every org-scoped table, and the app role may delete
--    a row, because removing a machine from a group deletes it.
-- 2. security.security_events_event_type_check admits
--    tacho.machine_group_changed, the audit row for each change to a group.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. tacho.machine_group_members
CREATE TABLE IF NOT EXISTS tacho.machine_group_members (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  group_name text NOT NULL,
  host_id uuid NOT NULL,
  CONSTRAINT machine_group_members_public_id_unique UNIQUE(public_id),
  CONSTRAINT "tacho_machine_group_members_host_fk" FOREIGN KEY ("host_id") REFERENCES "tacho"."hosts" ("id") ON DELETE CASCADE,
  CONSTRAINT "tacho_machine_group_members_group_name_check" CHECK (group_name ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS tacho_machine_group_members_uniq ON tacho.machine_group_members (workspace_id, group_name, host_id);
CREATE INDEX IF NOT EXISTS tacho_machine_group_members_host_idx ON tacho.machine_group_members (org_id, workspace_id, host_id);
ALTER TABLE tacho.machine_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.machine_group_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.machine_group_members;
DROP POLICY IF EXISTS tenant_org_wide_read ON tacho.machine_group_members;
CREATE POLICY tenant_isolation ON tacho.machine_group_members
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON tacho.machine_group_members
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tacho.machine_group_members TO oxagen_app;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The machine group audit event.
ALTER TABLE security.security_events DROP CONSTRAINT IF EXISTS security_events_event_type_check;
ALTER TABLE security.security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'agent.interjection_answered', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.invalidated', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published', 'steering.governance_changed', 'steering.governance_overridden', 'sso.provider_created', 'sso.domain_verified', 'sso.provider_updated', 'sso.provider_deleted', 'sso.policy_updated', 'sso.group_roles_set', 'sso.sign_in', 'scim.token_created', 'scim.token_rotated', 'scim.token_revoked', 'scim.user_provisioned', 'scim.user_updated', 'scim.user_deprovisioned', 'scim.group_changed', 'scim.request_denied', 'tacho.host_revoked', 'tacho.workspace_runs_paused', 'tacho.machine_group_changed'));
