-- Reseller Revenue — the "Stripe for agents" re-bill loop (docs/web-app-2.0/org/billing/revenue/spec.md).
--
-- Six org-scoped tables in the existing `billing` schema let a reseller meter
-- observed agent usage per END-CUSTOMER, price it, and push it to an invoice in
-- the reseller's OWN Stripe account:
--   billing.reseller_customers          (rescus_…)  — the end-customers a reseller bills
--   billing.reseller_price_plans        (resplan_…) — markup / per-unit pricing
--   billing.reseller_attribution_rules  (resrule_…) — usage slice → customer
--   billing.reseller_rebill_runs        (resrun_…)  — one push per (customer, period)
--   billing.reseller_rebill_line_items  (resli_…)   — priced lines of a run
--   billing.reseller_settings           (resset_…)  — per-org reseller Stripe key (encrypted)
--
-- Conventions mirror the billing schema exactly: uuid id + citext public_id,
-- created/updated audit columns, soft delete on the mutable config tables, and
-- ORG-ONLY row-level security (billing is org-scoped, not workspace-scoped — the
-- tenant_isolation policy matches 20260612140000_restore_rls_policies.sql).

-- ── billing.reseller_price_plans ─────────────────────────────────────────────
-- Created first so reseller_customers can FK its price_plan_id.
CREATE TABLE "billing"."reseller_price_plans" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  -- 'markup' | 'per_unit'. Validated in zod AND by the mode/rate check below.
  "pricing_mode" text NOT NULL,
  -- Basis points of markup over raw cost; set for markup mode (2000 = +20%).
  "markup_bps" integer NULL,
  -- Flat cents per metered unit; set for per_unit mode.
  "unit_price_cents" integer NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_price_plans_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_price_plans_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "reseller_price_plans_pricing_mode_check"
    CHECK (pricing_mode IN ('markup', 'per_unit')),
  -- The chosen mode must carry its own rate — a plan can never be half-defined.
  CONSTRAINT "reseller_price_plans_rate_check"
    CHECK (
      (pricing_mode = 'markup' AND markup_bps IS NOT NULL)
      OR (pricing_mode = 'per_unit' AND unit_price_cents IS NOT NULL)
    )
);
CREATE INDEX "reseller_price_plans_org_idx"
  ON "billing"."reseller_price_plans" ("org_id");

-- ── billing.reseller_customers ───────────────────────────────────────────────
CREATE TABLE "billing"."reseller_customers" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  -- The reseller's own external identifier for this customer (CRM id, etc.).
  "external_ref" text NULL,
  -- Cached customer id in the reseller's Stripe account, once a push creates one.
  "stripe_customer_id" text NULL,
  -- App-enforced-friendly FK to reseller_price_plans.id; RESTRICT so an in-use
  -- plan cannot be hard-deleted out from under a customer.
  "price_plan_id" uuid NULL,
  -- 'active' | 'paused'. Paused customers are excluded from pushes.
  "status" text NOT NULL DEFAULT 'active',
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_customers_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_customers_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "reseller_customers_price_plan_fk"
    FOREIGN KEY ("price_plan_id") REFERENCES "billing"."reseller_price_plans" ("id") ON DELETE RESTRICT,
  CONSTRAINT "reseller_customers_status_check"
    CHECK (status IN ('active', 'paused'))
);
CREATE INDEX "reseller_customers_org_idx"
  ON "billing"."reseller_customers" ("org_id");
CREATE INDEX "reseller_customers_price_plan_idx"
  ON "billing"."reseller_customers" ("price_plan_id");

-- ── billing.reseller_attribution_rules ───────────────────────────────────────
CREATE TABLE "billing"."reseller_attribution_rules" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  -- 'workspace' | 'principal' | 'capability' — the observed-usage dimension.
  "match_kind" text NOT NULL,
  -- Raw identifier matched (workspace/principal uuid, or capability name).
  "match_value" text NOT NULL,
  -- Human label captured at creation, shown instead of the raw match value.
  "match_label" text NOT NULL,
  -- App-enforced FK to reseller_customers.id; the customer this slice bills to.
  "customer_id" uuid NOT NULL,
  -- Lower runs first; the first matching rule wins a usage slice.
  "priority" integer NOT NULL DEFAULT 100,
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_attribution_rules_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_attribution_rules_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "reseller_attribution_rules_customer_fk"
    FOREIGN KEY ("customer_id") REFERENCES "billing"."reseller_customers" ("id") ON DELETE CASCADE,
  CONSTRAINT "reseller_attribution_rules_match_kind_check"
    CHECK (match_kind IN ('workspace', 'principal', 'capability'))
);
CREATE INDEX "reseller_attribution_rules_org_priority_idx"
  ON "billing"."reseller_attribution_rules" ("org_id", "priority");
CREATE INDEX "reseller_attribution_rules_customer_idx"
  ON "billing"."reseller_attribution_rules" ("customer_id");

-- ── billing.reseller_rebill_runs ─────────────────────────────────────────────
CREATE TABLE "billing"."reseller_rebill_runs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  -- Reseller's own raw metered cost for the period, in cents.
  "subtotal_cents" integer NOT NULL DEFAULT 0,
  -- What the customer is billed after the plan is applied, in cents.
  "total_cents" integer NOT NULL DEFAULT 0,
  -- Reseller-account invoice + customer ids, once pushed.
  "provider_invoice_id" text NULL,
  "provider_customer_id" text NULL,
  "hosted_invoice_url" text NULL,
  -- 'pending' | 'pushed' | 'failed'.
  "status" text NOT NULL DEFAULT 'pending',
  "error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_rebill_runs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_rebill_runs_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "reseller_rebill_runs_customer_fk"
    FOREIGN KEY ("customer_id") REFERENCES "billing"."reseller_customers" ("id") ON DELETE CASCADE,
  CONSTRAINT "reseller_rebill_runs_status_check"
    CHECK (status IN ('pending', 'pushed', 'failed')),
  -- Idempotency: one run per (org, customer, period). Re-push updates in place.
  CONSTRAINT "reseller_rebill_runs_customer_period_uniq"
    UNIQUE ("org_id", "customer_id", "period_start", "period_end")
);
CREATE INDEX "reseller_rebill_runs_org_created_idx"
  ON "billing"."reseller_rebill_runs" ("org_id", "created_at" DESC);
CREATE INDEX "reseller_rebill_runs_customer_idx"
  ON "billing"."reseller_rebill_runs" ("customer_id");

-- ── billing.reseller_rebill_line_items ───────────────────────────────────────
-- Priced snapshot lines of a run. Replaced wholesale on re-push (delete + insert),
-- so only a created_at audit column — never independently updated.
CREATE TABLE "billing"."reseller_rebill_line_items" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  -- Human label for the attributed slice (never a raw uuid).
  "label" text NOT NULL,
  -- Which dimension produced this line, or null for an aggregate line.
  "match_kind" text NULL,
  "match_value" text NULL,
  "raw_cost_cents" integer NOT NULL DEFAULT 0,
  "quantity" integer NOT NULL DEFAULT 0,
  "unit_price_cents" integer NULL,
  "amount_cents" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_rebill_line_items_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_rebill_line_items_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "reseller_rebill_line_items_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "billing"."reseller_rebill_runs" ("id") ON DELETE CASCADE,
  CONSTRAINT "reseller_rebill_line_items_match_kind_check"
    CHECK (match_kind IS NULL OR match_kind IN ('workspace', 'principal', 'capability'))
);
CREATE INDEX "reseller_rebill_line_items_run_idx"
  ON "billing"."reseller_rebill_line_items" ("run_id");
CREATE INDEX "reseller_rebill_line_items_org_idx"
  ON "billing"."reseller_rebill_line_items" ("org_id");

-- ── billing.reseller_settings ────────────────────────────────────────────────
-- Per-org reseller Stripe key, envelope-encrypted at rest (@oxagen/crypto). One
-- row per org. The ciphertext + its crypto keyId are stored; only a last-4
-- fingerprint is ever surfaced.
CREATE TABLE "billing"."reseller_settings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  -- Envelope-encrypted reseller Stripe secret key + its crypto keyId for routing.
  "stripe_secret_ciphertext" bytea NULL,
  "stripe_secret_key_id" text NULL,
  -- Non-secret fingerprint + label safe to show in the UI.
  "stripe_secret_last4" text NULL,
  "stripe_account_label" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "reseller_settings_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "reseller_settings_org_unique" UNIQUE ("org_id"),
  CONSTRAINT "reseller_settings_org_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id")
);

-- ── RLS — org-only tenant_isolation on all six tables ────────────────────────
-- Matches the billing-schema policy in 20260612140000_restore_rls_policies.sql.

ALTER TABLE billing.reseller_price_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_price_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_price_plans;
CREATE POLICY tenant_isolation ON billing.reseller_price_plans
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.reseller_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_customers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_customers;
CREATE POLICY tenant_isolation ON billing.reseller_customers
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.reseller_attribution_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_attribution_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_attribution_rules;
CREATE POLICY tenant_isolation ON billing.reseller_attribution_rules
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.reseller_rebill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_rebill_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_rebill_runs;
CREATE POLICY tenant_isolation ON billing.reseller_rebill_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.reseller_rebill_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_rebill_line_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_rebill_line_items;
CREATE POLICY tenant_isolation ON billing.reseller_rebill_line_items
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.reseller_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reseller_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reseller_settings;
CREATE POLICY tenant_isolation ON billing.reseller_settings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- ── oxagen_app grants for the new billing tables ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_price_plans TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_customers TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_attribution_rules TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_rebill_runs TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_rebill_line_items TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON billing.reseller_settings TO oxagen_app';
  END IF;
END
$$;
