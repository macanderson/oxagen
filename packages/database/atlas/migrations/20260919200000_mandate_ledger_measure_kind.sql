-- ADR-108's kind lives on `tools.mandates.limits`, and a whole-record
-- `limits` replacement (update_mandate_limits) can remove a measure that
-- already has ledger movements. The ledger is append-only and keeps those
-- rows, but with the measure gone from the current record, nothing durable
-- says whether the old movement was money or a count: the app mapper fell
-- back to guessing from `unit_or_currency`, the exact wrong-answer case
-- ADR-108 exists to close (a count legitimately denominated in a
-- currency-code unit reads as money).
--
-- Stamped at write time on every `reserve` and `settle`/`release` row from
-- the mandate's own resolved `kind` for that measure, never re-derived.
-- Null only on a row written before this column existed; a reader falls
-- back to `legacyMeasureKindGuess` for those, the same fallback
-- `withResolvedKinds` already documents for a stored limit with no kind.
ALTER TABLE "tools"."mandate_ledger"
  ADD COLUMN IF NOT EXISTS "measure_kind" text;
