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
--      requested_gau is what the money reversal is worth against the purchase,
--      capped at what that purchase has left to give: quantity_gau less the
--      requested_gau already recorded by rows for the same settlement, since a
--      refund and a dispute of one purchase arrive as separate events and a
--      bucket is one balance for the org rather than one per purchase.
--      reversed_gau is what came out of the org's live bucket, unrecovered_gau
--      the difference —
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

-- ── 1b. The purchases that already exist get that identity too ──────────────
--
-- Adding the column is not enough. Every checkout settlement recorded before
-- this migration has stripe_payment_intent_id NULL, and the createGauCheckout
-- that paid for it put no metadata on the PaymentIntent either, so its Charge
-- cannot name the purchase from the other side. A refund or dispute against
-- one of those still-spendable purchases would match no settlement, could not
-- be parked, and would leave the units in the bucket — the exact money-loss
-- this migration exists to close, still open for every purchase made before
-- it ran.
--
-- The identity is recoverable without calling Stripe. billing.stripe_events is
-- an immutable raw-event store: processStripeEvent inserts the full webhook
-- payload BEFORE dispatching it, never updates the row, and nothing in the
-- tree deletes one. A kind='checkout' settlement can only have been created by
-- grantGauPurchaseForCheckout, whose single caller is the
-- checkout.session.completed branch of that dispatch. So the event that
-- created each of these rows is still here, keyed by the session id the
-- settlement already records, and the coverage of this backfill is a property
-- of how the rows are written rather than a matter of retention luck.
--
-- charged_cents is taken from the same payload for the same reason. Without
-- it, reversibleGau falls back to the subtotal, and since a refund's amount
-- includes refunded tax, a PARTIAL refund of a legacy purchase over-withdraws
-- by exactly the tax rate — the defect fixed for new rows earlier in this
-- change, left in place for old ones. Coalesced, so a value already recorded
-- is never overwritten.
--
-- Deliberately ordered before the unique index below: if this ever produced
-- two settlements sharing a PaymentIntent, the index would refuse to build and
-- take the whole migration down, rather than committing a silent collision.
UPDATE "billing"."gau_settlements" AS s
SET "stripe_payment_intent_id" = e.payment_intent,
    "charged_cents" = COALESCE(s."charged_cents", e.amount_total)
FROM (
  -- DISTINCT ON keeps one event per session, and the rows it chooses between
  -- are already filtered to those that actually carry a PaymentIntent. Doing
  -- that filtering here rather than outside is deliberate: an unfiltered
  -- DISTINCT ON would pick the most recent event for a session even if that
  -- one lacked the identity, discarding an earlier delivery that had it and
  -- silently narrowing the backfill.
  SELECT DISTINCT ON (c.session_id)
    c.session_id,
    c.payment_intent,
    c.amount_total
  FROM (
    SELECT
      ev."payload"->'data'->'object'->>'id' AS session_id,
      -- A webhook payload carries the PaymentIntent unexpanded, as a string
      -- id. Handled as an object too, so a payload captured with an expansion
      -- set does not silently backfill NULL over a recoverable identity.
      CASE
        WHEN jsonb_typeof(ev."payload"->'data'->'object'->'payment_intent') = 'object'
          THEN ev."payload"->'data'->'object'->'payment_intent'->>'id'
        ELSE ev."payload"->'data'->'object'->>'payment_intent'
      END AS payment_intent,
      (ev."payload"->'data'->'object'->>'amount_total')::bigint AS amount_total,
      ev."received_at" AS received_at
    FROM "billing"."stripe_events" ev
    WHERE ev."event_type" = 'checkout.session.completed'
  ) AS c
  WHERE c.payment_intent IS NOT NULL
    AND c.session_id IS NOT NULL
  ORDER BY c.session_id, c.received_at DESC
) AS e
WHERE s."kind" = 'checkout'
  AND s."stripe_payment_intent_id" IS NULL
  AND s."stripe_checkout_session_id" IS NOT NULL
  AND s."stripe_checkout_session_id" = e.session_id;

-- Whatever the backfill could not reach is a purchase whose refund still
-- cannot be recognised, so it is said out loud at deploy time rather than
-- discovered when the money goes. A WARNING and not an EXCEPTION on purpose:
-- a row this cannot reach is not fixable from inside the migration, and
-- wedging every future deploy behind it would trade a bounded, alerting blind
-- spot for an unbounded outage. onChargeRefunded refuses to claw back usage
-- credits while any of these remain, so the residue fails safe as well as loud.
DO $$
DECLARE
  unresolved bigint;
BEGIN
  SELECT count(*) INTO unresolved
  FROM "billing"."gau_settlements"
  WHERE "kind" = 'checkout' AND "stripe_payment_intent_id" IS NULL;

  IF unresolved > 0 THEN
    RAISE WARNING 'ADR-085: % checkout GAU settlement(s) still carry no stripe_payment_intent_id after the backfill. A refund or dispute against one of these cannot be matched to its purchase and its units will NOT be withdrawn. Resolve each from the Stripe dashboard before relying on the reversal path.', unresolved;
  END IF;
END $$;

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
