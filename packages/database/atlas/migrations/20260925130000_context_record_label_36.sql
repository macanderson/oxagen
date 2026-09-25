-- A context record's label is at most 36 characters (ADR-178). The label is
-- the record's name on every surface, so it has to fit a heading, a list row
-- and a breadcrumb. 20260923233000 allowed 200.
--
-- Longer labels are cut the way fitContextRecordLabel cuts them: whitespace
-- collapsed, then cut at the last word boundary that fits, or at 36
-- characters when the first word is longer than that. The slug is untouched.
--
-- Both tables force row-level security, so the update runs with the bypass
-- set for this transaction only. A row the update missed fails the new check,
-- which stops the migration rather than leaving a label over the cap.
SELECT set_config('app.rls_bypass', 'on', true);

UPDATE agent.context_records AS r
SET label = CASE
    WHEN length(f.tidy) <= 36 THEN f.tidy
    WHEN position(' ' IN left(f.tidy, 37)) > 0
      THEN rtrim(regexp_replace(left(f.tidy, 37), ' [^ ]*$', ''))
    ELSE left(f.tidy, 36)
  END
FROM (
  SELECT id, btrim(regexp_replace(label, '\s+', ' ', 'g')) AS tidy
  FROM agent.context_records
  WHERE length(btrim(label)) > 36
) AS f
WHERE r.id = f.id;

UPDATE agent.context_proposals AS p
SET label = CASE
    WHEN length(f.tidy) <= 36 THEN f.tidy
    WHEN position(' ' IN left(f.tidy, 37)) > 0
      THEN rtrim(regexp_replace(left(f.tidy, 37), ' [^ ]*$', ''))
    ELSE left(f.tidy, 36)
  END
FROM (
  SELECT id, btrim(regexp_replace(label, '\s+', ' ', 'g')) AS tidy
  FROM agent.context_proposals
  WHERE length(btrim(label)) > 36
) AS f
WHERE p.id = f.id;

SELECT set_config('app.rls_bypass', '', true);

ALTER TABLE agent.context_records DROP CONSTRAINT context_records_label_check;
ALTER TABLE agent.context_records ADD CONSTRAINT context_records_label_check
  CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 36));

ALTER TABLE agent.context_proposals DROP CONSTRAINT context_proposals_label_check;
ALTER TABLE agent.context_proposals ADD CONSTRAINT context_proposals_label_check
  CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 36));
