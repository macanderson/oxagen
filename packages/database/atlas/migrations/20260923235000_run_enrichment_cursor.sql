-- Track the exact recorded input and last observation independently of the generated summary.
-- summary_observed_revision holds the row's updated_at as the enrichment read saw it, so a
-- write that commits after the read differs from it even when its timestamp is older.
ALTER TABLE agent.agent_runs ADD COLUMN summary_input_digest text, ADD COLUMN summary_observed_at timestamptz, ADD COLUMN summary_observed_revision timestamptz;
ALTER TABLE tacho.sessions ADD COLUMN summary_input_digest text, ADD COLUMN summary_observed_at timestamptz, ADD COLUMN summary_observed_revision timestamptz;
