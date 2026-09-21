-- Modify "agent_runs" table
ALTER TABLE "agent"."agent_runs" ADD COLUMN "ingress_paused" boolean NOT NULL DEFAULT false;
