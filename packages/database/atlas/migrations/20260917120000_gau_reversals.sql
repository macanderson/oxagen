-- ADR-084: a refunded or disputed GAU block purchase withdraws the units it
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
-- RLS for the new table is in 20260917120100_rls_gau_reversals.sql (generated
-- from the tenant policy manifest).

-- ── 1. The purchase's payment identity ───────────────────────────────────────
ALTER TABLE "billing"."gau_settlements"
  ADD COLUMN "stripe_payment_intent_id" text NULL;

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
  "settlement_id" uuid NOT NULL,
  "bucket_id" uuid NOT NULL,
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
  CONSTRAINT "gau_reversals_quantities_check" CHECK ((requested_gau >= 0) AND (reversed_gau >= 0) AND (unrecovered_gau >= 0) AND ((reversed_gau + unrecovered_gau) = requested_gau) AND (amount_cents >= 0))
);

-- The idempotency key: a redelivered charge.refunded or
-- charge.dispute.created finds this row and withdraws nothing twice.
CREATE UNIQUE INDEX "gau_reversals_settlement_event_idx"
  ON "billing"."gau_reversals" ("settlement_id", "provider_event_id");
-- Readers reach a reversal through its bucket, as they do a settlement.
CREATE INDEX "gau_reversals_bucket_idx"
  ON "billing"."gau_reversals" ("bucket_id");
