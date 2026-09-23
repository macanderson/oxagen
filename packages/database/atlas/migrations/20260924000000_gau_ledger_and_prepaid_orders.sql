-- ADR-158: every billed governed action is a ledger row, and an enterprise
-- order paid in advance is a prepaid order.
--
-- 1. billing.gau_ledger: one row per billed governed action, written in the
--    same transaction that adds its units to billing.gau_buckets.used_gau.
--    The unique (org_id, idempotency_key) index is what makes a retried action
--    bill once. Append-only: the app role gets SELECT and INSERT only.
-- 2. billing.prepaid_orders: an order invoiced in advance on a Stripe
--    invoice: the platform licence for a period, prepaid governed action
--    units and prepaid usage credits, granted when the invoice is paid.
--
-- Both are org-wide money records: org_id NOT NULL, no workspace_id column,
-- the org_only RLS class (tenant-policy.manifest.ts).

-- ── 1. The governed-action ledger ────────────────────────────────────────────
CREATE TABLE "billing"."gau_ledger" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "bucket_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "source" text NOT NULL,
  "capability" text NULL,
  "tool_name" text NULL,
  "mcp_server" text NULL,
  "surface" text NULL,
  "harness" text NULL,
  "attributed_workspace_id" uuid NULL,
  "agent_id" text NULL,
  "principal_id" text NULL,
  "principal_kind" text NULL,
  "operator_user_id" text NULL,
  "run_id" text NULL,
  "session_id" text NULL,
  "tool_call_id" text NULL,
  "request_id" text NULL,
  "units" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "billed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "gau_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "gau_ledger_bucket_id_gau_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "billing"."gau_buckets" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "gau_ledger_source_check" CHECK (source = ANY (ARRAY['kernel'::text, 'tacho'::text, 'external_tool'::text])),
  CONSTRAINT "gau_ledger_units_positive" CHECK (units > 0),
  CONSTRAINT "gau_ledger_subject_check" CHECK ((capability IS NOT NULL) OR (tool_name IS NOT NULL))
);

-- The dedup arbiter: the recorder inserts ON CONFLICT DO NOTHING and debits
-- only the rows that inserted.
CREATE UNIQUE INDEX "gau_ledger_org_idempotency_idx"
  ON "billing"."gau_ledger" ("org_id", "idempotency_key");
-- Statements select WHERE org_id AND billed_at in [from, to).
CREATE INDEX "gau_ledger_org_billed_idx"
  ON "billing"."gau_ledger" ("org_id", "billed_at");
-- Reconciliation of a bucket against its rows.
CREATE INDEX "gau_ledger_bucket_idx"
  ON "billing"."gau_ledger" ("bucket_id");

-- ── 2. Prepaid orders ────────────────────────────────────────────────────────
CREATE TABLE "billing"."prepaid_orders" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "agreement_ref" text NULL,
  "po_number" text NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "licence_cents" bigint NOT NULL DEFAULT 0,
  "licence_period_start" timestamptz NULL,
  "licence_period_end" timestamptz NULL,
  "gau_quantity" bigint NOT NULL DEFAULT 0,
  "rate_per_gau_micros" bigint NOT NULL DEFAULT 0,
  "credit_cents" bigint NOT NULL DEFAULT 0,
  "grant_on" text NOT NULL DEFAULT 'paid',
  "status" text NOT NULL DEFAULT 'draft',
  "days_until_due" integer NOT NULL DEFAULT 30,
  "memo" text NULL,
  "stripe_invoice_id" text NULL,
  "granted_bucket_id" uuid NULL,
  "units_granted_at" timestamptz NULL,
  "credits_granted_at" timestamptz NULL,
  "issued_by_request_id" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "paid_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "prepaid_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "prepaid_orders_granted_bucket_id_gau_buckets_id_fk" FOREIGN KEY ("granted_bucket_id") REFERENCES "billing"."gau_buckets" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "prepaid_orders_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'open'::text, 'paid'::text, 'void'::text, 'uncollectible'::text])),
  CONSTRAINT "prepaid_orders_grant_on_check" CHECK (grant_on = ANY (ARRAY['paid'::text, 'issue'::text])),
  CONSTRAINT "prepaid_orders_amounts_check" CHECK ((licence_cents >= 0) AND (gau_quantity >= 0) AND (rate_per_gau_micros >= 0) AND (credit_cents >= 0) AND (((licence_cents + gau_quantity) + credit_cents) > 0) AND (((gau_quantity * rate_per_gau_micros) % (10000)::bigint) = 0) AND ((days_until_due >= 0) AND (days_until_due <= 365))),
  CONSTRAINT "prepaid_orders_licence_period_check" CHECK (((licence_period_start IS NULL) = (licence_period_end IS NULL)) AND ((licence_period_end IS NULL) OR (licence_period_end > licence_period_start)) AND ((licence_cents = 0) OR (licence_period_start IS NOT NULL)))
);

CREATE UNIQUE INDEX "prepaid_orders_stripe_invoice_idx"
  ON "billing"."prepaid_orders" ("stripe_invoice_id")
  WHERE (stripe_invoice_id IS NOT NULL);
CREATE INDEX "prepaid_orders_org_created_idx"
  ON "billing"."prepaid_orders" ("org_id", "created_at");

-- ── 3. Row-level security (org_only) ─────────────────────────────────────────
ALTER TABLE billing.gau_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.gau_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.gau_ledger;
DROP POLICY IF EXISTS tenant_org_wide_read ON billing.gau_ledger;
CREATE POLICY tenant_isolation ON billing.gau_ledger
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.prepaid_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.prepaid_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.prepaid_orders;
DROP POLICY IF EXISTS tenant_org_wide_read ON billing.prepaid_orders;
CREATE POLICY tenant_isolation ON billing.prepaid_orders
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT ON billing.gau_ledger TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE ON billing.prepaid_orders TO oxagen_app;
  END IF;
END $$;
