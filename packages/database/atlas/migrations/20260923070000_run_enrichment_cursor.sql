-- Track the exact recorded input and last observation independently of the generated summary.
ALTER TABLE agent.agent_runs ADD COLUMN summary_input_digest text, ADD COLUMN summary_observed_at timestamptz;
ALTER TABLE tacho.sessions ADD COLUMN summary_input_digest text, ADD COLUMN summary_observed_at timestamptz;
