-- 0004_billing_schema_integrity.sql
--
-- OXA-1424: Harden billing schema.
--
-- Policy: forward-only (pre-launch, no production data). Never edits a
-- shipped migration. All constraints are additive; no destructive DDL on
-- existing tables except deliberate column removals (updated_at/updated_by_user_id
-- from the append-only usage_records table, and public_id from the internal
-- audit tables credit_ledger, invoice_line_items, stripe_events).
--
-- Down migration (documented, not run):
--   DROP TABLE billing.stripe_event_processing;
--   ALTER TABLE billing.stripe_events ADD COLUMN processed_at timestamptz,
--     ADD COLUMN processing_error text,
--     ADD COLUMN public_id citext UNIQUE NOT NULL DEFAULT '';
--   ALTER TABLE billing.invoice_line_items ADD COLUMN public_id citext UNIQUE NOT NULL DEFAULT '';
--   ALTER TABLE billing.credit_ledger ADD COLUMN public_id citext UNIQUE NOT NULL DEFAULT '';
--   ALTER TABLE billing.usage_records ADD COLUMN updated_at timestamptz,
--     ADD COLUMN updated_by_user_id uuid;
--   ALTER TABLE billing.credit_balances DROP CONSTRAINT credit_balances_balance_non_negative;
--   ALTER TABLE billing.credit_ledger DROP CONSTRAINT credit_ledger_delta_non_zero;
--   ALTER TABLE billing.plans DROP CONSTRAINT plans_tier_check;
--   ALTER TABLE billing.subscriptions DROP CONSTRAINT subscriptions_billing_interval_check;
--   DROP INDEX billing.subscriptions_org_active_idx;
--   -- (FK constraints would be removed individually with DROP CONSTRAINT)

------------------------------------------------------------
-- 1. Foreign-key constraints — org / plan / subscription references
--    The DDL in 0000_init.sql already declared these FKs; this step
--    adds them to any environment that was initialised after 0003 renamed
--    the schema (org vs organization) and to Drizzle's schema model so
--    `drizzle-kit generate` is a no-op.
------------------------------------------------------------

-- billing.subscriptions → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.subscriptions
      ADD CONSTRAINT subscriptions_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

-- billing.subscriptions → billing.plans (planId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_plan_id_billing_plans_id_fk'
  ) THEN
    ALTER TABLE billing.subscriptions
      ADD CONSTRAINT subscriptions_plan_id_billing_plans_id_fk
      FOREIGN KEY (plan_id) REFERENCES billing.plans(id);
  END IF;
END $$;

-- billing.payment_methods → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'payment_methods'
      AND constraint_name = 'payment_methods_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.payment_methods
      ADD CONSTRAINT payment_methods_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

-- billing.invoices → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'invoices'
      AND constraint_name = 'invoices_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.invoices
      ADD CONSTRAINT invoices_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

-- billing.invoices → billing.subscriptions (subscriptionId, nullable)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'invoices'
      AND constraint_name = 'invoices_subscription_id_billing_subscriptions_id_fk'
  ) THEN
    ALTER TABLE billing.invoices
      ADD CONSTRAINT invoices_subscription_id_billing_subscriptions_id_fk
      FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);
  END IF;
END $$;

-- billing.invoice_line_items → billing.invoices (invoiceId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'invoice_line_items'
      AND constraint_name = 'invoice_line_items_invoice_id_billing_invoices_id_fk'
  ) THEN
    ALTER TABLE billing.invoice_line_items
      ADD CONSTRAINT invoice_line_items_invoice_id_billing_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES billing.invoices(id) ON DELETE CASCADE;
  END IF;
END $$;

-- billing.usage_records → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'usage_records'
      AND constraint_name = 'usage_records_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.usage_records
      ADD CONSTRAINT usage_records_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

-- billing.usage_records → billing.subscriptions (subscriptionId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'usage_records'
      AND constraint_name = 'usage_records_subscription_id_billing_subscriptions_id_fk'
  ) THEN
    ALTER TABLE billing.usage_records
      ADD CONSTRAINT usage_records_subscription_id_billing_subscriptions_id_fk
      FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);
  END IF;
END $$;

-- billing.credit_balances → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'credit_balances'
      AND constraint_name = 'credit_balances_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.credit_balances
      ADD CONSTRAINT credit_balances_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

-- billing.credit_ledger → org.organizations (orgId)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'credit_ledger'
      AND constraint_name = 'credit_ledger_org_id_org_organizations_id_fk'
  ) THEN
    ALTER TABLE billing.credit_ledger
      ADD CONSTRAINT credit_ledger_org_id_org_organizations_id_fk
      FOREIGN KEY (org_id) REFERENCES org.organizations(id);
  END IF;
END $$;

------------------------------------------------------------
-- 2. CHECK constraints — money invariants
------------------------------------------------------------

-- plans.tier IN ('free','pro','enterprise')
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'plans'
      AND constraint_name = 'plans_tier_check'
  ) THEN
    ALTER TABLE billing.plans
      ADD CONSTRAINT plans_tier_check
      CHECK (tier IN ('free','pro','enterprise'));
  END IF;
END $$;

-- subscriptions.billing_interval IN ('month','year')
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'subscriptions'
      AND constraint_name = 'subscriptions_billing_interval_check'
  ) THEN
    ALTER TABLE billing.subscriptions
      ADD CONSTRAINT subscriptions_billing_interval_check
      CHECK (billing_interval IN ('month','year'));
  END IF;
END $$;

-- credit_ledger.delta_cents <> 0
-- NOTE: If any existing rows have delta_cents = 0 this will fail — flag for
-- backfill (DELETE or UPDATE those rows before running on a live database).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'credit_ledger'
      AND constraint_name = 'credit_ledger_delta_non_zero'
  ) THEN
    ALTER TABLE billing.credit_ledger
      ADD CONSTRAINT credit_ledger_delta_non_zero
      CHECK (delta_cents <> 0);
  END IF;
END $$;

-- credit_balances.balance_cents >= 0 (NO overdraft)
-- NOTE: If any existing rows have balance_cents < 0 this will fail — flag for
-- backfill (UPDATE balance to 0 for any negative rows) before running on a
-- live database.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'billing'
      AND table_name = 'credit_balances'
      AND constraint_name = 'credit_balances_balance_non_negative'
  ) THEN
    ALTER TABLE billing.credit_balances
      ADD CONSTRAINT credit_balances_balance_non_negative
      CHECK (balance_cents >= 0);
  END IF;
END $$;

------------------------------------------------------------
-- 3. Drop mutable columns from append-only tables
------------------------------------------------------------

-- usage_records: drop updated_at and updated_by_user_id.
-- These columns came from auditMixin() but usage_records is append-only;
-- dropping them enforces the immutability invariant at the DB level.
ALTER TABLE billing.usage_records
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS updated_by_user_id;

-- invoice_line_items: drop public_id.
-- Internal detail table; no external ID surface. The public_id unique index
-- must be dropped first.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'billing' AND tablename = 'invoice_line_items'
      AND indexname = 'invoice_line_items_public_id_key'
  ) THEN
    DROP INDEX billing.invoice_line_items_public_id_key;
  END IF;
END $$;
ALTER TABLE billing.invoice_line_items DROP COLUMN IF EXISTS public_id;

-- credit_ledger: drop public_id.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'billing' AND tablename = 'credit_ledger'
      AND indexname = 'credit_ledger_public_id_key'
  ) THEN
    DROP INDEX billing.credit_ledger_public_id_key;
  END IF;
END $$;
ALTER TABLE billing.credit_ledger DROP COLUMN IF EXISTS public_id;

-- stripe_events: drop public_id, processed_at, processing_error.
-- processed_at and processing_error move to stripe_event_processing below.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'billing' AND tablename = 'stripe_events'
      AND indexname = 'stripe_events_public_id_key'
  ) THEN
    DROP INDEX billing.stripe_events_public_id_key;
  END IF;
END $$;
ALTER TABLE billing.stripe_events
  DROP COLUMN IF EXISTS public_id,
  DROP COLUMN IF EXISTS processed_at,
  DROP COLUMN IF EXISTS processing_error;

------------------------------------------------------------
-- 4. Create billing.stripe_event_processing
--    Mutable sibling of stripe_events: one row per processed event.
--    Separating it ensures stripe_events is truly append-only.
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing.stripe_event_processing (
  id uuid PRIMARY KEY DEFAULT COALESCE(
    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
      THEN uuid_generate_v7()
      ELSE uuid_generate_v4()
    END,
    uuid_generate_v4()
  ),
  stripe_event_id uuid NOT NULL REFERENCES billing.stripe_events(id) ON DELETE CASCADE,
  processed_at timestamptz,
  processing_error text
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_event_processing_event_idx
  ON billing.stripe_event_processing (stripe_event_id);

------------------------------------------------------------
-- 5. Partial unique index: one 'active' subscription per org
------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_org_active_idx
  ON billing.subscriptions (org_id)
  WHERE status = 'active';
