-- agent.context_proposals holds every steering PR Oxagen opens (#5122,
-- ADR-264).
--
-- merge_context_pr lands a steering PR only from a proposal row. Until now
-- only a record proposal and a governance proposal had one, so the revert,
-- tools, import, memory, and workspace.toml PRs Oxagen opened could not merge
-- through Oxagen. Each opener now writes a row whose kind names its PR:
--
--   revert          revert_steering_pr's PR
--   tools           a tools/ PR from Studio, the server sync, or the server writer
--   import          the Markdown import's PR, and each PR the steering import
--                   (import_workspace_steering) opens from .oxagen/
--   memory_pr       a memory/<date> PR from the curator or a person's promotion
--   agent_file      the PR that adds agents/<name>.toml when a host enrolls (#5149)
--   agent_proposal  the PR an agent opens with propose_steering (#5134)
--   workspace       the workspace.toml PR link_repository and unlink_repository open
--
-- None of them publishes a single record or appends a promotion event for
-- one, so a merged row of any of these kinds needs only merged_commit, as a
-- merged governance row does. A merged record row still needs all three of
-- merged_commit, published_record_id, and promotion_event_id.
--
-- DROP and re-ADD, in one transaction. Every row the previous constraints
-- admitted is still admitted.

ALTER TABLE "agent"."context_proposals"
  DROP CONSTRAINT "context_proposals_kind_check",
  ADD CONSTRAINT "context_proposals_kind_check" CHECK (kind = ANY (ARRAY['rule'::text, 'constraint'::text, 'procedure'::text, 'fact'::text, 'memory'::text, 'preference'::text, 'governance'::text, 'revert'::text, 'tools'::text, 'import'::text, 'memory_pr'::text, 'agent_file'::text, 'agent_proposal'::text, 'workspace'::text]));

ALTER TABLE "agent"."context_proposals"
  DROP CONSTRAINT "context_proposals_merged_check",
  ADD CONSTRAINT "context_proposals_merged_check" CHECK ((status = 'merged'::text) = ((merged_commit IS NOT NULL) AND ((kind <> ALL (ARRAY['rule'::text, 'constraint'::text, 'procedure'::text, 'fact'::text, 'memory'::text, 'preference'::text])) OR ((promotion_event_id IS NOT NULL) AND (published_record_id IS NOT NULL)))));
