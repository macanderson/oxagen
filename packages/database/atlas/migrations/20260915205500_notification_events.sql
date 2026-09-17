-- #2968: the notification feed carries the MC spec §7.7 event a row reports.
--
-- `kind` stays the coarse category the feed has always filtered on. `event`
-- names the outbound event that produced the row, restricted to the §7.7
-- names that have a producer in this release:
--
--   approval.requested  createApprovalRequest (packages/agent), one row per
--                       person who may resolve the approval
--   approval.resolved   resolve_approval, to the person whose message parked it
--   budget.breached     the spend-budget gate, when a ceiling is reached
--
-- The remaining §7.7 names (context_pr.opened, kill_switch.flipped,
-- reconciliation.exception, repository.indexed, run.proven) join the CHECK in
-- the change that adds their producer. Existing rows (the MCP re-auth alerts,
-- the budget threshold warnings below 100%) keep `event` null.

ALTER TABLE notification.notifications
  ADD COLUMN IF NOT EXISTS event text;

ALTER TABLE notification.notifications
  DROP CONSTRAINT IF EXISTS notifications_event_check;

ALTER TABLE notification.notifications
  ADD CONSTRAINT notifications_event_check
  CHECK (event IS NULL OR event IN ('approval.requested', 'approval.resolved', 'budget.breached'));
