-- Demote every Tacho session whose gateway tier came off the wire.
--
-- `enforcement_tier = 'gateway'` is the claim that Oxagen itself served and
-- could refuse the action (ADR-078 section 5): server-enforced, as against the
-- `client_attested` grade a `harness` row carries. Exports sign it and replay
-- grading reads it.
--
-- Until the fix that accompanies this migration, `ingest_tacho_events` wrote
-- `agent.enforcement_tier` from the batch straight onto the session row. A
-- batch is a report FROM the machine, and every agent on an enrolled host can
-- reach the ingest endpoint with the host key, so the tier was a grade the
-- governed agent wrote about itself — sealed into a chain the same producer
-- computed, and therefore perfectly valid on verification.
--
-- No shipped producer sets that field. The collector records a gateway call in
-- the envelope's `attrs`, on the daemon's own chain, and never populates
-- `agent.enforcement_tier` (`packages/tacho/src/collector/daemon.ts`). So every
-- `gateway` row in this table is uncorroborated by construction, and the
-- predicate needs no further narrowing: there is no legitimate row to spare.
--
-- The replacement is exactly what the handler now derives, from the host mode
-- already denormalised onto the row at genesis. `tacho.sessions` is a
-- projection of the event ledger, so this restores a derived value; it does not
-- edit evidence. The ClickHouse `tacho_events` rows are the ledger itself and
-- are deliberately left alone — rewriting an append-only evidence store is a
-- decision an operator makes, not a migration.
UPDATE tacho.sessions
   SET enforcement_tier = CASE
         WHEN bundle_mode = 'enforce' THEN 'harness'
         ELSE 'observe'
       END,
       updated_at = now()
 WHERE enforcement_tier = 'gateway';
