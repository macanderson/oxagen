-- ADR-108's kind lives on `tools.mandates.limits`, and a whole-record
-- `limits` replacement (update_mandate_limits) can remove a measure that
-- already has ledger movements. The ledger is append-only and keeps those
-- rows, but with the measure gone from the current record, nothing durable
-- says whether the old movement was money or a count: the app mapper fell
-- back to guessing from `unit_or_currency`, the exact wrong-answer case
-- ADR-108 exists to close (a count legitimately denominated in a
-- currency-code unit reads as money).
--
-- Stamped at write time: `reserve` takes it from the live tool declaration
-- the call is decided against, never from the mandate's own stored
-- `limits[measure].kind` (a legacy row's stored kind is only a guess, not a
-- fact worth making durable), and `settle`/`release` carry the reservation
-- row's stamp forward unchanged. Null only on a row written before this
-- column existed; a reader falls back to `legacyMeasureKindGuess` for those,
-- the same fallback `withResolvedKinds` already documents for a stored
-- limit with no kind.
ALTER TABLE "tools"."mandate_ledger"
  ADD COLUMN IF NOT EXISTS "measure_kind" text;
