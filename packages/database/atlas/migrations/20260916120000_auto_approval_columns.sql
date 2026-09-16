-- ADR-070 (G2970): the record an auto-approval leaves on an approval request
-- (MC spec §6.9 part 2).
--
-- Hand-written from the drizzle schema (packages/database/src/schema/agent.ts)
-- and reviewed; the statements below are this change's only. No new table: the
-- rules themselves are the second clause of the rule set already stored in
-- workspace.workspaces.settings.decisionRules (ADR-070 decision 2), so there is
-- nothing to grant, and agent.approval_requests keeps the tenant + workspace
-- RLS it already carries.
--
--   1. auto_rule_id — the auto-approval rule that was read when the call was
--      parked, whether or not it qualified. The 30-day hit and held-by-a-floor
--      counters list_approval_rules reports are a grouped count over it, which
--      is why it is indexed with created_at.
--   2. resolved_reasons — every reason the call did not qualify, empty when it
--      did. The eligibility line on an approval card renders from it.
--   3. resolved_by_policy — `policy:<rule id>` when a rule resolved the request
--      and no person looked. Its form is checked, and it is exclusive with
--      resolved_by_user_id, so a receipt can never read a policy decision as
--      somebody's.
--
-- The two CHECKs are NOT VALID: approval_requests holds resolved history, and
-- both constraints are true of every existing row by construction (the columns
-- are new and default to NULL / '{}'), so they bind every future insert without
-- a validating scan.

ALTER TABLE "agent"."approval_requests"
  ADD COLUMN IF NOT EXISTS "auto_rule_id" text,
  ADD COLUMN IF NOT EXISTS "resolved_reasons" text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS "resolved_by_policy" text;

CREATE INDEX IF NOT EXISTS "approval_requests_auto_rule_idx"
  ON "agent"."approval_requests" ("workspace_id", "auto_rule_id", "created_at")
  WHERE "auto_rule_id" IS NOT NULL;

ALTER TABLE "agent"."approval_requests"
  DROP CONSTRAINT IF EXISTS "approval_requests_resolved_by_policy_form_check";
ALTER TABLE "agent"."approval_requests"
  ADD CONSTRAINT "approval_requests_resolved_by_policy_form_check"
  CHECK ("resolved_by_policy" IS NULL OR "resolved_by_policy" ~ '^policy:[a-z0-9][a-z0-9._-]*$') NOT VALID;

ALTER TABLE "agent"."approval_requests"
  DROP CONSTRAINT IF EXISTS "approval_requests_one_approver_check";
ALTER TABLE "agent"."approval_requests"
  ADD CONSTRAINT "approval_requests_one_approver_check"
  CHECK (NOT ("resolved_by_policy" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL)) NOT VALID;
