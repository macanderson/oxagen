-- ADR-061 (#2961): widen the security_events event_type CHECK by one value,
-- steering.published — the audit event merge_context_pr writes when a Context
-- PR merges and publishes a record.
--
-- The event_type CHECK is a shared cell: every migration that touches it DROPs
-- and re-ADDs the entire constraint, and security-event-types.test.ts holds the
-- LATEST such migration byte-identical to generateEventTypeCheckClause()
-- (packages/compliance/src/db-check.ts). The constraint below was generated
-- from the taxonomy in packages/compliance/src/security-event-types.ts — do
-- not hand-edit the list.
--
-- It follows 20260915140500, which re-adds the constraint for the organization
-- roles events, so the list below carries those values too.
--
-- Additive (one value added, none removed), so the constraint validates the
-- whole table without NOT VALID. DROP + re-ADD keeps the operation idempotent
-- on a clean database; security_events is RANGE-partitioned on occurred_at and
-- altering the parent propagates the CHECK to every child partition.

ALTER TABLE "security"."security_events" DROP CONSTRAINT IF EXISTS "security_events_event_type_check";
ALTER TABLE "security"."security_events" ADD CONSTRAINT "security_events_event_type_check"
  CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published'));
