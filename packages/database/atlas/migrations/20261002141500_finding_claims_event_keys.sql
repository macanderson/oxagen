-- #4506, ADR-208 item 5 as amended: a wrapped run's frame key is now the
-- frame's chain and its seq on that chain, `<at>#<session uuid>:<seq>`. It
-- was `<at>#<n>`, the frame's place among the run's frames at that instant,
-- and that place moved when a frame of the same instant became visible later.
--
-- An open finding's claims are rewritten by every findings pass, so they take
-- the new keys on the next pass. An applied finding's claims are never
-- rewritten. Left with the old keys, they no longer match the key a later
-- finding gives the same frame, and the headline would count that frame
-- twice. So this deletes every claim of each applied finding that still holds
-- an old key on a wrapped run (`tse_…`). The next pass gives each such finding
-- the claims a replay finds for it, under the new keys (`claimBackfill`).
--
-- A ledger run (`arun_…`) has no chain, so its frames keep `<at>#<n>`, and a
-- claim that names one stays. A dismissed finding's claims never count, so
-- they stay too.
--
-- Both tables force row-level security, so the delete runs with the bypass
-- set for this transaction only.
SELECT set_config('app.rls_bypass', 'on', true);

DELETE FROM cost.finding_claims
WHERE finding_id IN (
  SELECT c.finding_id
  FROM cost.finding_claims AS c
  JOIN cost.findings AS f ON f.id = c.finding_id
  WHERE f.status = 'applied'
    AND c.run_id LIKE 'tse\_%'
    AND c.frame_key ~ '#[0-9]+$'
);

SELECT set_config('app.rls_bypass', '', true);
