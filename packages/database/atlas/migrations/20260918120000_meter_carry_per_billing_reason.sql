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
-- The CHECK asserts an object with no negative bucket. Only the lower bound:
-- the upper bound is a property of how consumeCredits writes, not something a
-- single statement can be held to. `jsonb_path_exists` with a
-- timezone-independent predicate is immutable, so it is legal here.
ALTER TABLE "billing"."org_billing_settings"
  ADD COLUMN IF NOT EXISTS "meter_carry_micro_credits_by_reason" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Carry the existing residue forward rather than dropping it. Every pooled
-- fraction was accrued under the OLD single markup, so it is marked-up money
-- and belongs on a marked-up line: it is attributed to `consume_embedding`, the
-- other reason that reaches this path. Attributing it to
-- `consume_assistant_tokens` instead would import exactly the margin this
-- change exists to keep off that line. The residue is under one credit per
-- organisation by construction.
UPDATE "billing"."org_billing_settings"
   SET "meter_carry_micro_credits_by_reason" =
       jsonb_build_object('consume_embedding', "meter_carry_micro_credits")
 WHERE "meter_carry_micro_credits" > 0;

ALTER TABLE "billing"."org_billing_settings"
  DROP CONSTRAINT IF EXISTS "org_billing_settings_meter_carry_non_negative";

-- Dropped rather than left behind: nothing reads it after this migration, and a
-- column whose comment still calls itself the carry is a trap for the next
-- reader. Apply this migration and deploy together — code from before it writes
-- the old column.
ALTER TABLE "billing"."org_billing_settings"
  DROP COLUMN IF EXISTS "meter_carry_micro_credits";

ALTER TABLE "billing"."org_billing_settings"
  ADD CONSTRAINT "org_billing_settings_meter_carry_by_reason_non_negative"
  CHECK (
    jsonb_typeof("meter_carry_micro_credits_by_reason") = 'object'
    AND NOT jsonb_path_exists("meter_carry_micro_credits_by_reason", '$.* ? (@ < 0)')
  );
