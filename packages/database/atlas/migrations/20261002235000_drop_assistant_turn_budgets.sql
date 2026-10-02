-- #5102, ADR-277: drop the per-turn budgets for Oxagen's in-app assistant.
--
-- Mac ruled on 2026-10-02 (ADR-235) that no customer sets a budget for the
-- in-app assistant. Four capabilities stored one: get_user_budget and
-- update_user_budget kept a person's own per-turn budget, and
-- get_budget_policy and update_budget_policy kept a workspace's per-turn
-- policy. The assistant's turn stopped reading both in #4935, and this change
-- deletes all four capabilities. Their handlers were the only readers of the
-- storage below.
--
--   1. workspace.workspace_budget_policy is dropped. Its RLS policies, its
--      unique constraint, and its index go with it.
--   2. auth.user_preferences loses the four per_turn_budget_* columns. Every
--      other preference column stays.
--
-- Data: each row is a budget nothing enforces, so there is nothing to carry
-- forward.

-- 1. The workspace per-turn policy
DROP TABLE IF EXISTS "workspace"."workspace_budget_policy";

-- 2. A person's own per-turn budget
ALTER TABLE "auth"."user_preferences"
  DROP COLUMN IF EXISTS "per_turn_budget_enabled",
  DROP COLUMN IF EXISTS "per_turn_budget_usd",
  DROP COLUMN IF EXISTS "per_turn_budget_mode",
  DROP COLUMN IF EXISTS "per_turn_budget_grace_pct";
