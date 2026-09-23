-- Nullable during the rolling deployment; the recurring job fills legacy rows.
ALTER TABLE agent.context_records ADD COLUMN label text;
ALTER TABLE agent.context_records ADD CONSTRAINT context_records_label_check
  CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 200));

-- A proposal carries the label its author asked for. NULL keeps the record's
-- current label when the Context PR merges.
ALTER TABLE agent.context_proposals ADD COLUMN label text;
ALTER TABLE agent.context_proposals ADD CONSTRAINT context_proposals_label_check
  CHECK (label IS NULL OR (length(btrim(label)) BETWEEN 1 AND 200));
