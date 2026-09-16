-- org.organizations.negotiated_actions_annual — the governed-action commitment
-- for an organisation that has no billing.plans row to carry one.
--
-- ADR-052 §4.2 put the allowance on the plan row precisely because "negotiated"
-- must not mean "absent": an absent allowance is indistinguishable from an
-- unlimited one, and resolveActionAllowance refuses to read it as unlimited —
-- it falls back to the scale figure and logs `billing_enterprise_allowance_missing`
-- on EVERY governed action. But the plan row is only reachable through an
-- ENTITLED subscription, and a subscription row needs a real
-- stripe_subscription_id. So an enterprise organisation that never went through
-- Stripe checkout — Oxagen's own tenant, a design partner on a signed
-- agreement, an internal demo org — had nowhere at all to record its commitment
-- and permanently alerted as mis-provisioned.
--
-- This column is the legacy tier leg's equivalent of
-- billing.plans.included_actions_annual, read by resolveOrgActionEntitlement
-- from the organizations row that query ALREADY selects, so it costs no extra
-- round trip on the accrual path.
--
-- Nullable and additive on purpose: NULL keeps today's behaviour exactly (fall
-- back to the tier default, and for enterprise to the scale figure with the
-- alert), so nothing changes for an organisation nobody has provisioned. The
-- subscription leg still wins when one exists — this is the fallback's
-- fallback, never an override of a plan a customer is actually paying for.
--
-- CHECK >= 0 mirrors billing.plans.included_actions_annual: a negative
-- commitment is not a smaller one, it is a corrupt row.
ALTER TABLE "org"."organizations"
  ADD COLUMN "negotiated_actions_annual" bigint NULL;

ALTER TABLE "org"."organizations"
  ADD CONSTRAINT "organizations_negotiated_actions_annual_check"
  CHECK ("negotiated_actions_annual" IS NULL OR "negotiated_actions_annual" >= 0);
