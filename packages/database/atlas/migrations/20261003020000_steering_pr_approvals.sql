-- Steering PR approvals given in Oxagen, and the managed-block findings of a
-- steering PR's latest check run (S7, #4518, ADR-267).
--
-- 1. agent.steering_pr_approvals holds one row per person who approved a
--    steering PR in Oxagen (approve_steering_pr), at the head commit they
--    approved. merge_steering_pr counts these rows beside the approvals on
--    the host: an approval counts only at a head the merge lands, from a
--    workspace member other than the author. A push to the branch moves the
--    head, so an older approval stops counting and the row stays as history.
--    The Oxagen GitHub App opens every steering PR, and GitHub refuses an
--    app's approving review of a pull request it opened, so an approval in
--    Oxagen cannot be a review on the host.
--
-- 2. agent.steering_proposals.check_findings holds what the latest check run
--    found on the PR's head: one entry per drifted managed block, as
--    [{ rule, path, line, message }]. The steering PR page draws Restore
--    block from it with no read of the host. A new check run resets it.

CREATE TABLE IF NOT EXISTS agent.steering_pr_approvals (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  public_id citext NOT NULL,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  commit_sha text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "steering_pr_approvals_public_id_unique" UNIQUE (public_id),
  CONSTRAINT "steering_pr_approvals_proposal_id_steering_proposals_id_fk" FOREIGN KEY (proposal_id) REFERENCES agent.steering_proposals (id) ON DELETE CASCADE,
  CONSTRAINT "steering_pr_approvals_commit_sha_check" CHECK (char_length(commit_sha) BETWEEN 7 AND 64)
);
-- One person approves one head once. Approving the same head again changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS steering_pr_approvals_head_uq ON agent.steering_pr_approvals (proposal_id, user_id, commit_sha);
-- The merge and the steering PR read list a proposal's approvals.
CREATE INDEX IF NOT EXISTS steering_pr_approvals_proposal_idx ON agent.steering_pr_approvals (org_id, workspace_id, proposal_id);

COMMENT ON TABLE agent.steering_pr_approvals IS
  'Approvals of a steering PR given in Oxagen, each at the head commit it approved (ADR-267).';
COMMENT ON COLUMN agent.steering_pr_approvals.commit_sha IS
  'The PR head the person approved. The approval counts only while the merge lands this head or a merge commit the queue made on it.';

ALTER TABLE agent.steering_pr_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.steering_pr_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.steering_pr_approvals;
DROP POLICY IF EXISTS tenant_org_wide_read ON agent.steering_pr_approvals;
CREATE POLICY tenant_isolation ON agent.steering_pr_approvals
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));
CREATE POLICY tenant_org_wide_read ON agent.steering_pr_approvals
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.steering_pr_approvals TO oxagen_app;
  END IF;
END $$;

ALTER TABLE agent.steering_proposals
  ADD COLUMN IF NOT EXISTS check_findings jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN agent.steering_proposals.check_findings IS
  'What the latest check run found on the PR head: each drifted managed block as { rule, path, line, message }. Reset when a check run starts.';
