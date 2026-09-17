-- ADR-070 (G2970): the security_events event_type CHECK gains the three
-- auto-approval events: approval.auto_approved (a call a decision rule sent to
-- a person that a rule released instead), approval_rule.changed and
-- approval_rule.deleted (the rules themselves)
-- (packages/compliance/src/security-event-types.ts, the taxonomy of record).
--
-- Every migration that touches this CHECK DROPs and re-ADDs the entire
-- constraint, regenerated from the merged taxonomy with
-- generateEventTypeCheckClause() (packages/compliance/src/db-check.ts);
-- security-event-types.test.ts holds the latest such migration byte-identical
-- to that output. Do not hand-edit the list.
--
-- It follows 20260915210500_tool_governance_security_events.sql, which re-adds
-- the constraint for #3025's two tool-governance events
-- (tool.kill_switch_flipped, tool.classification_changed), so the list below
-- carries those, the five mandate events before them, and everything earlier.
--
-- Those two arrived on app-rebuild after this branch cut, and this file was
-- written against the taxonomy as it stood then. Regenerated here from the
-- merged taxonomy: without that, this constraint would have silently dropped
-- both, and the emitters are fire-and-forget, so a kill-switch flip would
-- report success while its security event was refused.
--
-- NOT VALID, as 20260909210000_event_type_check_drops_reseller.sql explains:
-- security_events is append-only audit history, so the constraint binds every
-- future insert and leaves recorded rows untouched. The table is
-- RANGE-partitioned on occurred_at; altering the parent propagates the CHECK to
-- every child partition.

ALTER TABLE "security"."security_events" DROP CONSTRAINT IF EXISTS "security_events_event_type_check";
ALTER TABLE "security"."security_events" ADD CONSTRAINT "security_events_event_type_check"
  CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published')) NOT VALID;
