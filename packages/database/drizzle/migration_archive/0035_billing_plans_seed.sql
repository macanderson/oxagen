-- 0035: Seed billing.plans with the three canonical subscription tiers.
--
-- billing.plans is a shared platform catalog — not tenant-scoped, no RLS.
-- The table is created by 0000_baseline.sql with an empty body; the only
-- mechanism to populate it is the stripe-sync script (tools/scripts/stripe-sync.ts)
-- or this explicit seed migration.
--
-- Stripe resources created 2026-06-09 via Stripe MCP on acct_1TCS8FBqX8HwIjwR:
--   Build      prod_UfuMqY1Q8US0jA   monthly price_1TgYYWBqX8HwIjwRLxDg6YRE  annual price_1TgYYYBqX8HwIjwRKVa5GEsy
--   Scale      prod_UcKnVew6KyYiYK   monthly price_1Td67UBqX8HwIjwR4OR0vBAG   annual price_1Td67VBqX8HwIjwRtIt717Y1
--   Enterprise prod_UfuNpgIwWFha7V   monthly price_1TgYYfBqX8HwIjwREQJKJqbl  annual price_1TgYYgBqX8HwIjwR5uWN14QM
--
-- Re-running pnpm billing:stripe-sync --apply after this migration will find
-- the products via metadata.oxagen_slug and reuse these rows (onConflictDoUpdate
-- by slug is idempotent).
--
-- Forward migration — immutable after merge (OXA-1515 policy).

BEGIN;

INSERT INTO billing.plans (
  public_id,
  name,
  slug,
  tier,
  stripe_product_id,
  stripe_price_id_monthly,
  stripe_price_id_annual,
  monthly_cents,
  annual_cents,
  included_credit_cents,
  included_seats,
  features,
  is_public
) VALUES
  (
    'pln_build_v2_prod_seed_0001',
    'Build',
    'build-v2',
    'build',
    'prod_UfuMqY1Q8US0jA',
    'price_1TgYYWBqX8HwIjwRLxDg6YRE',
    'price_1TgYYYBqX8HwIjwRKVa5GEsy',
    2000,
    20000,
    2400,
    5,
    '{"list":["All tools & integrations","Up to 25 concurrent agents","Email support"]}',
    true
  ),
  (
    'pln_scale_v2_prod_seed_0001',
    'Scale',
    'scale-v2',
    'scale',
    'prod_UcKnVew6KyYiYK',
    'price_1Td67UBqX8HwIjwR4OR0vBAG',
    'price_1Td67VBqX8HwIjwRtIt717Y1',
    9900,
    99000,
    13200,
    25,
    '{"list":["All tools & integrations","Unlimited concurrent agents","Priority support"]}',
    true
  ),
  (
    'pln_ent_v2_prod_seed_0001',
    'Enterprise',
    'enterprise-v2',
    'enterprise',
    'prod_UfuNpgIwWFha7V',
    'price_1TgYYfBqX8HwIjwREQJKJqbl',
    'price_1TgYYgBqX8HwIjwR5uWN14QM',
    50000,
    500000,
    70000,
    5,
    '{"list":["Everything in Scale","Dedicated support","SSO & SCIM provisioning","Access control lists (ACLs)","Immutable audit log"]}',
    true
  )
ON CONFLICT (slug) DO UPDATE SET
  name                  = EXCLUDED.name,
  tier                  = EXCLUDED.tier,
  stripe_product_id     = EXCLUDED.stripe_product_id,
  stripe_price_id_monthly = EXCLUDED.stripe_price_id_monthly,
  stripe_price_id_annual  = EXCLUDED.stripe_price_id_annual,
  monthly_cents         = EXCLUDED.monthly_cents,
  annual_cents          = EXCLUDED.annual_cents,
  included_credit_cents = EXCLUDED.included_credit_cents,
  included_seats        = EXCLUDED.included_seats,
  features              = EXCLUDED.features,
  is_public             = EXCLUDED.is_public,
  updated_at            = now();

COMMIT;
