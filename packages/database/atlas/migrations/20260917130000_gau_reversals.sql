-- ADR-085: a refunded or disputed GAU block purchase withdraws the units it
-- granted.
--
-- Two changes:
--
--   1. billing.gau_settlements gains stripe_payment_intent_id. The webhook
--      grant records it, and it is the only identifier a later
--      charge.refunded or charge.dispute.created carries that reaches back to
--      the purchase: a Stripe Dispute has its own (empty) metadata rather than
--      the charge's, so propagating org_id onto the PaymentIntent — which this
--      change also does, in createGauCheckout — resolves a refund but never a
--      dispute. The index is unique and partial: one PaymentIntent charges one
--      Checkout Session, and every row written before this migration is NULL.
--
--   2. billing.gau_reversals records the withdrawal. Separate from the
--      settlement because a purchase can be reversed partially, because the
--      figure that matters (units actually recovered) is not the figure the
--      settlement carries, and because `paid` is the settlement ledger's only
--      terminal state by design.
--
--      requested_gau is what the money reversal is worth, reversed_gau what
--      came out of the org's live bucket, unrecovered_gau the difference —
--      units the customer already spent, or that rolled past the balance the
--      gate reads. billing.gau_buckets forbids a negative purchased_gau, so
--      the shortfall has nowhere to hide in the arithmetic and is recorded
--      instead.
--
-- RLS for the new table is in 20260917130100_rls_gau_reversals.sql (generated
-- from the tenant policy manifest).

-- ── 1. The purchase's payment identity ───────────────────────────────────────
ALTER TABLE "billing"."gau_settlements"
  ADD COLUMN "stripe_payment_intent_id" text NULL,
  -- What the session actually charged, tax included. The per-unit rate times
  -- the quantity reconstructs the SUBTOTAL, and a refund's amount includes
  -- refunded tax, so prorating a partial refund against the subtotal
  -- over-withdraws by the tax rate. NULL for a settlement recorded before this
  -- column existed; the subtotal is the fallback denominator there.
  ADD COLUMN "charged_cents" bigint NULL,
  ADD CONSTRAINT "gau_settlements_charged_cents_non_negative" CHECK (charged_cents IS NULL OR charged_cents >= 0);

CREATE UNIQUE INDEX "gau_settlements_payment_intent_idx"
  ON "billing"."gau_settlements" ("stripe_payment_intent_id")
  WHERE (stripe_payment_intent_id IS NOT NULL);

-- ── 2. The reversal ledger ───────────────────────────────────────────────────
CREATE TABLE "billing"."gau_reversals" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "settlement_id" uuid NULL,
  "bucket_id" uuid NULL,
  "stripe_payment_intent_id" text NOT NULL,
  "kind" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "requested_gau" bigint NOT NULL,
  "reversed_gau" bigint NOT NULL,
  "unrecovered_gau" bigint NOT NULL,
  "amount_cents" bigint NOT NULL,
  "currency" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "gau_reversals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "gau_reversals_settlement_id_gau_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "billing"."gau_settlements" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "gau_reversals_bucket_id_gau_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "billing"."gau_buckets" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "gau_reversals_kind_check" CHECK (kind = ANY (ARRAY['refund'::text, 'dispute'::text])),
  -- A row is pending (money returned, purchase not yet found) or settled, never
  -- half of each: both links are resolved by the same reconciliation.
  CONSTRAINT "gau_reversals_pending_consistency_check" CHECK ((settlement_id IS NULL) = (bucket_id IS NULL)),
  CONSTRAINT "gau_reversals_quantities_check" CHECK ((requested_gau >= 0) AND (reversed_gau >= 0) AND (unrecovered_gau >= 0) AND ((reversed_gau + unrecovered_gau) = requested_gau) AND (amount_cents >= 0))
);

-- The idempotency key: a redelivered charge.refunded or
-- charge.dispute.created finds this row and withdraws nothing twice.
--
-- Keyed on the PaymentIntent rather than the settlement, because a refund can
-- arrive before the purchase it reverses has been recorded — Stripe does not
-- order webhook deliveries, and a checkout grant that failed once is retried
-- later. One PaymentIntent charges one Checkout Session, so for a row that HAS
-- found its settlement this is the same key by another name.
CREATE UNIQUE INDEX "gau_reversals_payment_intent_event_idx"
  ON "billing"."gau_reversals" ("stripe_payment_intent_id", "provider_event_id");
-- The reconciliation's lookup: pending reversals awaiting their purchase.
CREATE INDEX "gau_reversals_pending_idx"
  ON "billing"."gau_reversals" ("stripe_payment_intent_id")
  WHERE (settlement_id IS NULL);
-- Readers reach a reversal through its bucket, as they do a settlement.
CREATE INDEX "gau_reversals_bucket_idx"
  ON "billing"."gau_reversals" ("bucket_id");
