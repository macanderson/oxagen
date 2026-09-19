-- Which catalog wrote a list row, so retirement can be per catalog.
--
-- The sync retired absent rows only on a run where every catalog answered,
-- because a row absent from the seeds could mean either "this price ended" or
-- "the catalog that publishes it was down this run", and the rows could not
-- say which catalog that was. So when models.dev failed and OpenRouter had
-- withdrawn a model, the OpenRouter row stayed open, and runs kept using a
-- withdrawn rate for as long as the unrelated catalog stayed down.
--
-- `catalog` records the publisher. A row from a catalog that answered
-- completely this run and no longer names it is retired; a row from a catalog
-- that failed or was held is preserved. Null for negotiated rows, and for list
-- rows written before this column existed, which the next sync's upsert
-- re-stamps (`catalog = EXCLUDED.catalog`).
ALTER TABLE "cost"."price_entries"
  ADD COLUMN IF NOT EXISTS "catalog" text;
