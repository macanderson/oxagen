-- Drop orphan agent.plan_steps table.
-- This table has migrations, RLS policies, and Drizzle relations but zero
-- INSERT callers in the codebase. Only UPDATE is referenced (agent.plan.approve)
-- but can never match existing rows since none are ever created.

DROP TABLE IF EXISTS "agent"."plan_steps" CASCADE;
