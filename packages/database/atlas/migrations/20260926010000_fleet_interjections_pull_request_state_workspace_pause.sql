-- Batch A3, the Fleet page. One Postgres migration for three changes.
--
-- 1. agent.interjections (#3839): a question a paused agent asked, when it was
--    raised, the 30-minute deadline, and the answer. list_interjections reads
--    the open ones; answer_interjection writes the answer once.
-- 2. tacho.run_pull_requests (#4129, ADR-192): the state a forge last reported
--    for each pull request a run's frames name, kept current by the GitHub and
--    GitLab webhooks and read by list_runs.
-- 3. security.security_events_event_type_check admits
--    tacho.workspace_runs_paused (#3862), the one audit row
--    pause_workspace_runs writes per decision. The clause is the output of
--    generateEventTypeCheckClause() in packages/compliance.
--
-- Both tables are tenant-isolated like every org-scoped table.

CREATE TABLE IF NOT EXISTS agent.interjections (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  run_public_id text NOT NULL,
  agent_key text,
  question text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  answered_at timestamptz,
  answer text,
  answered_by_user_id uuid,
  CONSTRAINT interjections_public_id_unique UNIQUE(public_id),
  CONSTRAINT "interjections_run_public_id_check" CHECK (run_public_id ~ '^(arun|tse)_[0-9a-z]+$'),
  CONSTRAINT "interjections_answer_check" CHECK ((answered_at IS NULL AND answer IS NULL AND answered_by_user_id IS NULL) OR (answered_at IS NOT NULL AND answer IS NOT NULL)),
  CONSTRAINT "interjections_window_check" CHECK (expires_at > raised_at)
);
CREATE INDEX IF NOT EXISTS interjections_open_idx ON agent.interjections (org_id, workspace_id, expires_at) WHERE answered_at IS NULL;
CREATE INDEX IF NOT EXISTS interjections_run_idx ON agent.interjections (workspace_id, run_public_id);
ALTER TABLE agent.interjections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.interjections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.interjections;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.interjections;
CREATE POLICY tenant_isolation ON agent.interjections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.interjections
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS tacho.run_pull_requests (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  url text NOT NULL,
  provider text NOT NULL,
  repository text NOT NULL,
  number integer NOT NULL,
  state text,
  draft boolean NOT NULL DEFAULT false,
  state_seen_at timestamptz,
  source_updated_at timestamptz,
  CONSTRAINT run_pull_requests_public_id_unique UNIQUE(public_id),
  CONSTRAINT "tacho_run_pull_requests_provider_check" CHECK (provider IN ('github', 'gitlab')),
  CONSTRAINT "tacho_run_pull_requests_state_check" CHECK (state IS NULL OR state IN ('open', 'merged', 'closed')),
  CONSTRAINT "tacho_run_pull_requests_number_check" CHECK (number > 0),
  CONSTRAINT "tacho_run_pull_requests_draft_check" CHECK (NOT draft OR state IS NULL OR state = 'open')
);
CREATE UNIQUE INDEX IF NOT EXISTS tacho_run_pull_requests_uniq ON tacho.run_pull_requests (session_id, url);
CREATE INDEX IF NOT EXISTS tacho_run_pull_requests_forge_idx ON tacho.run_pull_requests (org_id, provider, repository, number);
CREATE INDEX IF NOT EXISTS tacho_run_pull_requests_org_idx ON tacho.run_pull_requests (org_id, workspace_id);
ALTER TABLE tacho.run_pull_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.run_pull_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.run_pull_requests;
DROP POLICY IF EXISTS tenant_org_wide_read ON tacho.run_pull_requests;
CREATE POLICY tenant_isolation ON tacho.run_pull_requests
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON tacho.run_pull_requests
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE security.security_events DROP CONSTRAINT security_events_event_type_check;
ALTER TABLE security.security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.invalidated', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published', 'steering.governance_changed', 'steering.governance_overridden', 'sso.provider_created', 'sso.domain_verified', 'sso.provider_updated', 'sso.provider_deleted', 'sso.policy_updated', 'sso.group_roles_set', 'sso.sign_in', 'scim.token_created', 'scim.token_rotated', 'scim.token_revoked', 'scim.user_provisioned', 'scim.user_updated', 'scim.user_deprovisioned', 'scim.group_changed', 'scim.request_denied', 'tacho.host_revoked', 'tacho.workspace_runs_paused'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON agent.interjections TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON tacho.run_pull_requests TO oxagen_app;
  END IF;
END $$;
