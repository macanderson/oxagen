-- Record why the last automatic run account failed, so the Run page can say why a run has no
-- model-written name. The enrichment job clears it when an account is written or no longer due.
ALTER TABLE agent.agent_runs ADD COLUMN summary_error text;
ALTER TABLE tacho.sessions ADD COLUMN summary_error text;
-- The title the harness itself gave the session (Claude Code's ai-title), and the frame time it
-- carried. The Run page shows it ahead of any name Oxagen wrote. A frame older than the stored one
-- does not replace it.
ALTER TABLE tacho.sessions ADD COLUMN harness_title text;
ALTER TABLE tacho.sessions ADD COLUMN harness_title_at timestamptz;
