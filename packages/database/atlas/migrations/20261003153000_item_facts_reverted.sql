-- #5244: work.item_facts records a revert of a send's merged pull request.
--
-- A `reverted` fact is a provider fact on a work order. GitHub merged a pull
-- request whose body names the send's merged pull request as
-- `Reverts <owner>/<repo>#<n>`, the line GitHub's Revert button writes. The
-- fact names the reverting pull request, its merge commit, and the pull
-- request it reverts. It never moves the item out of done: a person reopens
-- the item. It only feeds the revert count in get_work_outcomes (ADR-286,
-- amended 2026-10-03).
--
-- `reverted` belongs to a work order, so both constraints that list the kinds
-- change: item_facts_kind_check names every kind, and item_facts_order_check
-- requires an order on each order kind. The lists match FACT_KINDS and
-- ORDER_FACT_KINDS in @oxagen/work, in the same order.
--
-- DROP and re-ADD, in one transaction. Every row the previous constraints
-- admitted is still admitted.
--
-- The stamp is later than the clock at writing (07:15 UTC), because main
-- already carried 20261003150000 and the gate applies migrations in order.

ALTER TABLE work.item_facts
  DROP CONSTRAINT "item_facts_kind_check",
  ADD CONSTRAINT "item_facts_kind_check" CHECK (kind IN ('collected', 'entered', 'source_changed', 'triage_recorded', 'triage_failed', 'triage_overridden', 'brief_saved', 'brief_approved', 'closed', 'reopened', 'send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed', 'reverted'));

ALTER TABLE work.item_facts
  DROP CONSTRAINT "item_facts_order_check",
  ADD CONSTRAINT "item_facts_order_check" CHECK ((kind IN ('send_requested', 'send_delivered', 'send_rejected', 'send_withdrawn', 'claimed', 'run_linked', 'run_ended', 'stop_requested', 'stopped', 'pr_linked', 'head_observed', 'checks_required', 'check_observed', 'criterion_claimed', 'returned', 'accepted', 'merged', 'pr_closed', 'reverted')) = (order_id IS NOT NULL));
