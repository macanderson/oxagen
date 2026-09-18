-- The sub-credit meter carry becomes one bucket per billing reason.
--
-- meter_carry_micro_credits (#1413) banked every fractional charge in a single
-- org-wide counter. That is exact in total and wrong in attribution: the
-- fractions of every reason shared one counter, so the call that happened to
-- cross the whole-credit boundary was billed for the fractions the other
-- reasons had accrued. A 0.9-credit embedding followed by a 0.1-credit
-- assistant turn wrote one whole credit as `consume_assistant_tokens`.
--
-- That mattered from the moment the reasons stopped sharing a price. ADR-053 §3
-- (amended 2026-09-18) bills `consume_assistant_tokens` at exactly the vendor
-- cost of the platform key, with no markup, while every other line on the same
-- chokepoint keeps the solved blended markup. A pooled carry therefore moved
-- embedding margin onto the at-cost assistant line and counted it against
-- assistant_spend_cap_cents, which can reject an assistant turn for spend it
-- never incurred.
--
-- Keyed by `credit_ledger.reason`, each value in micro-credits. consumeCredits
-- reads only the calling reason's bucket, adds this call's micro-credits,
-- debits the whole credits and writes back only the remainder, so every stored
-- value stays in [0, 1e6) — small enough to be exact as a JSON number. An
-- absent key means nothing is carried for that reason.
--
-- This is the EXPAND half of an expand-and-contract rollout, and it is
-- additive: it adds the new column and moves the residue across, and it leaves
-- `meter_carry_micro_credits` and its CHECK in place. Production applies
-- migrations by hand (`db-migrate.yml`) and `deploy-node` does not wait for
-- them, so the schema has to be correct under both versions of the code for as
-- long as the two overlap. Apply this migration BEFORE deploying the code that
-- reads the new column: code from before that deploy keeps writing the old
-- column, which still exists, and code from after it writes only the new one.
-- The CONTRACT half — fold whatever the old code accrued in the gap into the
-- `consume_embedding` bucket, then drop the old column and its CHECK — is a
-- later migration, applied once no node runs code that writes the old column.
--
-- The CHECK asserts an object with no negative bucket. Only the lower bound:
-- the upper bound is a property of how consumeCredits writes, not something a
-- single statement can be held to. `jsonb_path_exists` with a
-- timezone-independent predicate is immutable, so it is legal here.
ALTER TABLE "billing"."org_billing_settings"
  ADD COLUMN IF NOT EXISTS "meter_carry_micro_credits_by_reason" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Move the existing residue across rather than dropping it. Every pooled
-- fraction was accrued under the OLD single markup, so it is marked-up money
-- and belongs on a marked-up line: it is attributed to `consume_embedding`, the
-- other reason that reaches this path. Attributing it to
-- `consume_assistant_tokens` instead would import exactly the margin this
-- change exists to keep off that line. The residue is under one credit per
-- organisation by construction.
--
-- The old column is zeroed in the same statement, so the residue is banked in
-- exactly one place: code from before the deploy, still writing the old
-- column, starts again from nothing rather than debiting a whole credit for
-- fractions the new column has already taken over.
UPDATE "billing"."org_billing_settings"
   SET "meter_carry_micro_credits_by_reason" =
       jsonb_build_object('consume_embedding', "meter_carry_micro_credits"),
       "meter_carry_micro_credits" = 0
 WHERE "meter_carry_micro_credits" > 0;

ALTER TABLE "billing"."org_billing_settings"
  ADD CONSTRAINT "org_billing_settings_meter_carry_by_reason_non_negative"
  CHECK (
    jsonb_typeof("meter_carry_micro_credits_by_reason") = 'object'
    AND NOT jsonb_path_exists("meter_carry_micro_credits_by_reason", '$.* ? (@ < 0)')
  );
