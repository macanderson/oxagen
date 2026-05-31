-- 0009_pricing_tiers_build_scale_enterprise.sql
--
-- Expand the billing.plans.tier CHECK from (free,pro,enterprise) to
-- (free,build,scale,enterprise) and remap existing self-serve rows to the new
-- tier names. The product lineup is now Free / Build / Scale / Enterprise
-- (source of truth: packages/billing/src/pricing.ts).
--
--   Pro  ($20)  -> Build  (slug pro-v2 -> build-v2, tier pro -> build)
--   Scale($99)  -> Scale  (slug unchanged; tier enterprise -> scale)
--   Enterprise($500, ACL/SSO/SCIM/audit) -> net-new, tier 'enterprise',
--     created by `pnpm billing:stripe-sync --apply` from pricing.ts.
--
-- Idempotent: the CHECK drop uses IF EXISTS and the remap WHERE-clauses no-op
-- once applied (and match no rows on a DB that only has the seeded Free plan,
-- since paid plans are created by stripe-sync, not the seed).
--
-- Down migration (documented, not run):
--   ALTER TABLE billing.plans DROP CONSTRAINT IF EXISTS plans_tier_check;
--   UPDATE billing.plans SET tier='pro', slug='pro-v2', name='Pro' WHERE slug='build-v2';
--   UPDATE billing.plans SET tier='enterprise' WHERE slug='scale-v2' AND tier='scale';
--   ALTER TABLE billing.plans ADD CONSTRAINT plans_tier_check
--     CHECK (tier IN ('free','pro','enterprise'));

ALTER TABLE billing.plans DROP CONSTRAINT IF EXISTS plans_tier_check;

-- Canonical Pro plan (pro-v2): rename slug + display so a later stripe-sync
-- upserts the same row instead of orphaning it.
UPDATE billing.plans
   SET slug = 'build-v2', name = 'Build'
 WHERE slug = 'pro-v2';

-- Pro -> Build for EVERY pro-tier row (covers pro-v2 and any legacy 'pro' rows
-- so none violates the new CHECK).
UPDATE billing.plans SET tier = 'build' WHERE tier = 'pro';

-- The old Scale plan carried the coarse 'enterprise' tier; it is now its own
-- 'scale' tier. Enterprise becomes a separate, priced net-new plan ('enterprise'
-- remains a valid tier for the new enterprise-v2 plan created by stripe-sync).
UPDATE billing.plans
   SET tier = 'scale'
 WHERE slug = 'scale-v2' AND tier = 'enterprise';

ALTER TABLE billing.plans
  ADD CONSTRAINT plans_tier_check CHECK (tier IN ('free','build','scale','enterprise'));
