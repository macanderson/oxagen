-- Modify "agent_execution_steps" table
ALTER TABLE "agent"."agent_execution_steps" ADD COLUMN "started_at" timestamptz NULL, ADD COLUMN "completed_at" timestamptz NULL;
-- Modify "agent_executions" table
ALTER TABLE "agent"."agent_executions" ALTER COLUMN "agent_id" DROP NOT NULL, ALTER COLUMN "agent_version_id" DROP NOT NULL;
