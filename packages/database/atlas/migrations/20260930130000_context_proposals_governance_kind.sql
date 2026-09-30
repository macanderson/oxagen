-- agent.context_proposals holds governance proposals (#4795).
--
-- In a team or regulated steering repository, set_governance_mode opens a
-- steering PR on steering/governance that changes steering/governance.toml,
-- and leaves it for review. merge_context_pr lands a steering PR from a
-- proposal row, so the review route now writes one: kind 'governance', on
-- the fixed lineage 'governance'. The open-PR index then allows one open
-- governance PR per workspace.
--
-- A governance merge publishes no record and appends no promotion event.
-- context_promotions keeps one hash chain per record, and its record_id is
-- NOT NULL. When merge_context_pr lands it, the approver is recorded on the
-- ledger line's Oxagen-Approved-By trailer, on merged_by_user_id here, and on
-- steering.governance_changed. The repository sync also records a governance
-- PR someone merged outside Oxagen, which has no Oxagen approver. So a merged
-- governance row needs only merged_commit. A merged record row still needs
-- all three of merged_commit, published_record_id, and promotion_event_id.
--
-- DROP and re-ADD, in one transaction. Every row the previous constraints
-- admitted is still admitted.

ALTER TABLE "agent"."context_proposals"
  DROP CONSTRAINT "context_proposals_kind_check",
  ADD CONSTRAINT "context_proposals_kind_check" CHECK (kind = ANY (ARRAY['rule'::text, 'constraint'::text, 'procedure'::text, 'fact'::text, 'memory'::text, 'preference'::text, 'governance'::text]));

ALTER TABLE "agent"."context_proposals"
  DROP CONSTRAINT "context_proposals_merged_check",
  ADD CONSTRAINT "context_proposals_merged_check" CHECK ((status = 'merged'::text) = ((merged_commit IS NOT NULL) AND ((kind = 'governance'::text) OR ((promotion_event_id IS NOT NULL) AND (published_record_id IS NOT NULL)))));
