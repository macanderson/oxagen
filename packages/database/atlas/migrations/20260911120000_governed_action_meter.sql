-- ADR-052: the governed action is the billable unit.
--
-- Three changes, all in the billing schema:
--
--   1. billing.governed_action_counters — the running count of governed actions
--      an organisation has taken in its current entitlement year. This is
--      transactional state, not analytics: the allowance decision for THIS
--      action needs the count including THIS action, atomically, in one round
--      trip. A ClickHouse read on the invoke() hot path could not give that
--      (eventually-consistent, and a second query per action), so the count
--      lives in Postgres and the per-capability breakdown stays in ClickHouse
--      where append-only analytics belongs.
--
--   2. billing.plans.included_actions_annual — the tier allowance from spec
--      §4.2, stored rather than implied. Spec §7.3: "negotiated" for enterprise
--      used to mean absent, and an absent allowance is indistinguishable from
--      an unlimited one. NOT NULL with a per-tier default backfill makes a
--      mis-provisioned plan under-bill by a bounded amount instead of running
--      free.
--
--   3. billing.org_billing_settings.extended_evidence_retention_enabled — spec
--      §7.4. Evidence retention beyond the included twelve months is OPT-IN.
--      Silently accruing storage charges on evidence a customer forgot they
--      were keeping is exactly the surprise ADR-052 exists to prevent, so the
--      default is false and the column is NOT NULL.

-- ── 1. The action counter ────────────────────────────────────────────────────
--
-- One row per (org, entitlement year). period_start is the first instant of the
-- org's entitlement year, UTC. The allowances in spec §4.2 and the volume bands
-- in §4.1 are both annual, so an annual window is the one that makes the
-- counter's own number directly comparable to both without a conversion.
--
-- actions_used is the ONLY mutable column. The recorder does a single
-- INSERT … ON CONFLICT DO UPDATE … RETURNING, which takes the row lock, returns
-- the post-increment total, and settles the allowance question in one statement.
CREATE TABLE IF NOT EXISTS billing.governed_action_counters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES org.organizations(id) ON DELETE CASCADE,
  -- First instant of the entitlement year this row counts, UTC.
  period_start  timestamptz NOT NULL,
  -- Governed actions taken in the period, including those inside the allowance.
  -- Counting free actions too is the point: an org cannot see how close it is to
  -- its allowance from a ledger that only records what it was charged for.
  actions_used  bigint NOT NULL DEFAULT 0,
  -- Actions charged as overage. actions_used - actions_charged is what the
  -- allowance absorbed, which is the number the usage page shows as "included".
  actions_charged bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governed_action_counters_used_non_negative
    CHECK (actions_used >= 0 AND actions_charged >= 0),
  CONSTRAINT governed_action_counters_charged_within_used
    CHECK (actions_charged <= actions_used)
);

-- The ON CONFLICT arbiter. Also the only read path (org + period), so it is a
-- covering index for both.
CREATE UNIQUE INDEX IF NOT EXISTS governed_action_counters_org_period_idx
  ON billing.governed_action_counters (org_id, period_start);

-- RLS: the counter is org-scoped tenant state and is read through withTenantDb
-- on the invoke() hot path, so it needs the same policy every other tenant
-- table in this schema carries.
ALTER TABLE billing.governed_action_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.governed_action_counters FORCE ROW LEVEL SECURITY;

-- Policy body copied from billing.credit_ledger's in 20260612140000: the
-- app.rls_bypass escape hatch (withSystemDb) and the org-only predicate
-- (no workspace column on this table).
DROP POLICY IF EXISTS tenant_isolation ON billing.governed_action_counters;
CREATE POLICY tenant_isolation ON billing.governed_action_counters
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- ── 2. Tier allowances on the plan row ───────────────────────────────────────
ALTER TABLE billing.plans
  ADD COLUMN IF NOT EXISTS included_actions_annual bigint NOT NULL DEFAULT 25000;

-- Backfill the spec §4.2 allowances onto existing plans. The DEFAULT above is
-- the free-tier figure, so a plan row created by an older code path lands on the
-- most restrictive allowance rather than an unlimited one.
UPDATE billing.plans SET included_actions_annual = 25000     WHERE tier = 'free';
UPDATE billing.plans SET included_actions_annual = 250000    WHERE tier = 'build';
UPDATE billing.plans SET included_actions_annual = 1500000   WHERE tier = 'scale';
-- Enterprise is negotiated per contract (spec §7.3). It seeds at the scale
-- allowance so a plan row that nobody has set yet cannot read as unlimited; the
-- real committed figure is written when the contract is signed.
UPDATE billing.plans SET included_actions_annual = 1500000   WHERE tier = 'enterprise';

ALTER TABLE billing.plans
  DROP CONSTRAINT IF EXISTS plans_included_actions_non_negative;
ALTER TABLE billing.plans
  ADD CONSTRAINT plans_included_actions_non_negative
  CHECK (included_actions_annual >= 0);

-- ── 3. Extended evidence retention is opt-in ─────────────────────────────────
ALTER TABLE billing.org_billing_settings
  ADD COLUMN IF NOT EXISTS extended_evidence_retention_enabled boolean NOT NULL DEFAULT false;
