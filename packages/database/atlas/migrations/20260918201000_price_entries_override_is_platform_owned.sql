-- An operator override is the platform's row, not an organisation's.
--
-- `cost.price_entries.source` has carried 'override' since the table was
-- created, but the org/source check read `(source = 'list') = (org_id IS NULL)`,
-- which forbade an override row with a null org. The sync therefore wrote
-- every operator-override rate as 'list', and once written nothing could tell
-- it from a catalog row.
--
-- That mattered on a run where a catalog was down: the sync retires absent
-- rows only on a complete snapshot, so an override the operator had REMOVED
-- stayed open until every catalog answered, which a persistent outage makes
-- never, and runs kept billing on terms the operator withdrew. The overrides
-- are this installation's own environment and are read completely on every
-- run, so a withdrawn one can retire immediately, but only if the row says it
-- was an override.
--
-- The check now admits 'override' beside 'list' for a null org. Rows already
-- written as 'list' from an override are re-stamped by the next sync's upsert,
-- which carries `source = EXCLUDED.source`, so no data repair runs here.
ALTER TABLE "cost"."price_entries"
  DROP CONSTRAINT IF EXISTS "price_entries_org_source_check";
ALTER TABLE "cost"."price_entries"
  ADD CONSTRAINT "price_entries_org_source_check"
  CHECK ((source IN ('list', 'override')) = (org_id IS NULL));
