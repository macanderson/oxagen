-- Record the plan a plan change is moving away from, before the swap.
--
-- `grantProratedPlanUpgradeCredits` sizes its grant from
-- `toPlan.included_credit_cents - fromPlan.included_credit_cents`. The swap
-- itself destroys the left-hand side: `upgradeSubscription` syncs the
-- subscription synchronously, and that sync repoints `plan_id` at the target.
-- A call that died between the swap and the grant therefore left a customer
-- upgraded and uncredited, and a retry could not recompute what to grant —
-- the row it would read had already been rewritten (#3157, PR #3171 review).
--
-- So the intent is written down before the provider is asked to do anything,
-- and cleared once the grant for that move has landed. A retry that finds the
-- subscription already on the target price reads this column and finishes the
-- job. Until the grant settles, the column is the only place the origin plan
-- still exists.
--
-- It is deliberately absent from `syncSubscriptionFromStripe`'s conflict SET,
-- so a provider sync cannot erase an intent whose work is unfinished.
--
-- Nullable, and NULL is the steady state: a subscription with no plan change
-- in flight carries none, as does every row predating this migration.
ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS pending_upgrade_from_plan_id uuid
    REFERENCES billing.plans (id);

COMMENT ON COLUMN billing.subscriptions.pending_upgrade_from_plan_id IS
  'Plan being moved away from by an in-flight plan change. Written before the provider swap, cleared once the prorated upgrade grant lands; NULL when no change is in flight. The only durable record of the origin plan, because the swap repoints plan_id at the target.';
