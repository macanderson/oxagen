-- Broaden the security_events event_type CHECK constraint to admit the five
-- reseller-revenue audit event types (billing.reseller_customer_changed,
-- billing.reseller_price_plan_changed, billing.reseller_attribution_rule_changed,
-- billing.reseller_stripe_configured, billing.reseller_rebill_pushed).
--
-- SOC 2 CC6.3/CC6.8: privileged reseller-revenue mutations (downstream
-- customer/price-plan/attribution-rule changes, BYO-Stripe connection
-- configuration, rebill invoice pushes) previously wrote no domain-specific
-- audit record while other billing mutations did. The handlers in
-- packages/handlers now emit these events; the taxonomy source of truth is
-- packages/compliance/src/security-event-types.ts and this constraint body was
-- generated from it via generateEventTypeCheckClause() (see db-check.ts).
--
-- Strategy: DROP + re-ADD the constraint so the operation is idempotent and
-- safe to replay on a clean database. security_events is RANGE-partitioned on
-- occurred_at; altering the parent propagates the CHECK to every child
-- partition. Atlas tracks idempotency via the atlas.sum checksum — do NOT edit
-- this file after it is applied.

ALTER TABLE "security"."security_events" DROP CONSTRAINT IF EXISTS "security_events_event_type_check";
ALTER TABLE "security"."security_events" ADD CONSTRAINT "security_events_event_type_check"
  CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.reseller_customer_changed', 'billing.reseller_price_plan_changed', 'billing.reseller_attribution_rule_changed', 'billing.reseller_stripe_configured', 'billing.reseller_rebill_pushed', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'security.mfa_policy_updated', 'security.session_revoked', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested'));
