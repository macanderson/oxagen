-- Record why the last automatic run account failed, so the Run page can say why a run has no
-- model-written name. The enrichment job clears it when an account is written or no longer due.
ALTER TABLE agent.agent_runs ADD COLUMN summary_error text;
ALTER TABLE tacho.sessions ADD COLUMN summary_error text;
