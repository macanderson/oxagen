-- What a subscriber actually pays, recorded on the subscription.
--
-- `billing.plans` holds the catalogue as it stands today. It is not what an
-- existing subscriber is billed: provider prices are immutable, so
-- `tools/scripts/stripe-sync.ts` mints a NEW price on a reprice and overwrites
-- the plan row, while every live subscription stays on the price it was
-- created with. A grandfathered $100 subscriber therefore sits behind a plan
-- row reading $200.
--
-- `changeOrgPlan` and `previewPlanChange` decide proration by comparing what
-- the org is billed now against what the target plan bills. Reading the
-- current figure off the plan row inverts that comparison for exactly those
-- subscribers: $100 → a $150 plan reads as $200 → $150, a decrease, and ships
-- `proration_behavior: 'none'` — no immediate charge for a real increase
-- (#3157, PR #3171 review).
--
-- These two columns carry the subscription's own price, written by
-- `syncSubscriptionFromStripe` on every `subscription.*` webhook, so the
-- comparison reads what the subscriber pays without a provider round trip on
-- the plan-change path.
--
-- Both are nullable: rows written before this migration have not been synced
-- yet, and a metered or tiered price legitimately carries no unit amount. The
-- read path treats NULL as "ask the provider", never as zero.
ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id text,
  ADD COLUMN IF NOT EXISTS unit_amount_cents integer;

COMMENT ON COLUMN billing.subscriptions.stripe_price_id IS
  'Provider price id this subscription is billed on. Immutable at the provider, so it survives a catalogue reprice that moves billing.plans.';
COMMENT ON COLUMN billing.subscriptions.unit_amount_cents IS
  'Cents charged per billing period by that price. The authoritative input to a proration direction; NULL means not yet synced or a non-unit-amount price.';
