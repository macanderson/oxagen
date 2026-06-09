-- 0006: Expand security_events CHECK constraint with billing and privacy event types.
--
-- Adds billing.checkout_initiated (from 0032_billing_checkout_event_type) and
-- privacy.export_requested / privacy.erasure_requested / privacy.org_erasure_requested
-- (from 0033_privacy_gdpr_tables) to the security_events event_type constraint.
--
-- Drops both possible pre-existing constraint names (_check and _chk) for safety,
-- then recreates as security_events_event_type_check with the full canonical set.
-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD.

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_check;

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_chk;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN (
    -- Auth lifecycle
    'auth.sign_in',
    'auth.sign_in_failed',
    'auth.sign_out',
    'auth.token_refreshed',
    'auth.password_changed',
    'auth.email_verified',
    -- API key lifecycle
    'api_key.created',
    'api_key.revoked',
    'api_key.used',
    -- Billing mutations
    'billing.access_denied',
    'billing.auto_reload_updated',
    'billing.checkout_initiated',
    'billing.credits_purchased',
    'billing.payment_method_added',
    'billing.payment_method_default_changed',
    'billing.payment_method_removed',
    'billing.plan_changed',
    'billing.seats_changed',
    'billing.subscription_canceled',
    'billing.subscription_reactivated',
    -- Capability authz
    'capability.invoke_allowed',
    'capability.invoke_denied',
    'capability.invoke_error',
    -- Org lifecycle
    'organization.created',
    'workspace.created',
    -- Admin / org management
    'org.member_invited',
    'org.member_removed',
    'org.role_changed',
    -- Security policy
    'security.mfa_policy_updated',
    'security.session_revoked',
    -- Access review
    'access.review_completed',
    'access.member_access_confirmed',
    -- GDPR privacy
    'privacy.export_requested',
    'privacy.erasure_requested',
    'privacy.org_erasure_requested'
  ));
