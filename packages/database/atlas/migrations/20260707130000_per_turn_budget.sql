-- Per-turn dollar budget: the user's saved default budget policy for a single
-- agent turn. OFF by default (enabled=false ⇒ turns run with no dollar ceiling).
-- When enabled, `per_turn_budget_usd` is the ceiling and `per_turn_budget_mode`
-- ("grace" | "prompt" | "enforce") decides what happens at it. `per_turn_budget_grace_pct`
-- is the grace-window cushion used only by "grace" mode (0.25 = allow 25% overage).
--
-- Backs the budget.policy.read / budget.policy.write capabilities. Columns live
-- on the existing 1:1 auth.user_preferences row (user-global, no org_id / no RLS).
--
-- Safe/online: adding nullable columns and NOT NULL columns WITH a constant
-- DEFAULT is a metadata-only change on modern Postgres (no table rewrite, no
-- long lock). Existing rows adopt the defaults (budget off).

ALTER TABLE "auth"."user_preferences"
  ADD COLUMN "per_turn_budget_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN "per_turn_budget_usd" real,
  ADD COLUMN "per_turn_budget_mode" text NOT NULL DEFAULT 'prompt',
  ADD COLUMN "per_turn_budget_grace_pct" real NOT NULL DEFAULT 0.25;
