-- Agent runtime epic. Hand-written per docs/epics/agent-runtime/spec.md §6.
-- Extends the agent schema with risk metadata, skills, background tasks,
-- approvals, subagent fanout, and plan steps. Cross-domain references
-- (chat.messages, execution.execution_steps) are app-enforced per
-- CLAUDE.md storage rules; only within-schema FKs are declared here.

------------------------------------------------------------
-- agent.tools — risk / approval / category extensions
------------------------------------------------------------

ALTER TABLE "agent"."tools"
  ADD COLUMN "requires_approval" boolean NOT NULL DEFAULT false,
  ADD COLUMN "risk_level" citext NOT NULL DEFAULT 'low',
  ADD COLUMN "category" text;

ALTER TABLE "agent"."tools"
  ADD CONSTRAINT "tools_risk_level_check"
  CHECK ("risk_level" IN ('low', 'medium', 'high'));

------------------------------------------------------------
-- agent.tool_assignments — per-workspace enable flag
------------------------------------------------------------

ALTER TABLE "agent"."tool_assignments"
  ADD COLUMN "is_enabled_in_workspace" boolean NOT NULL DEFAULT true;

------------------------------------------------------------
-- agent.mcp_servers — external-server auth + discovered-tools snapshot
------------------------------------------------------------

ALTER TABLE "agent"."mcp_servers"
  ADD COLUMN "auth_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "discovered_tools" jsonb NOT NULL DEFAULT '[]'::jsonb;

------------------------------------------------------------
-- agent.skills — logical skill identity
------------------------------------------------------------

CREATE TABLE "agent"."skills" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "description" text,
  "source" citext NOT NULL,
  CONSTRAINT "skills_source_check" CHECK ("source" IN ('builtin', 'tenant'))
);
CREATE UNIQUE INDEX "skills_workspace_slug_idx" ON "agent"."skills" ("workspace_id", "slug");
CREATE INDEX "skills_tenant_idx" ON "agent"."skills" ("tenant_id", "workspace_id");

------------------------------------------------------------
-- agent.skill_versions — immutable snapshots
------------------------------------------------------------

CREATE TABLE "agent"."skill_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid REFERENCES "agent"."skill_versions"("id"),
  "published_at" timestamptz,
  "skill_id" uuid NOT NULL REFERENCES "agent"."skills"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "references_payload" jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX "skill_versions_skill_idx" ON "agent"."skill_versions" ("skill_id");
CREATE UNIQUE INDEX "skill_versions_skill_latest_idx" ON "agent"."skill_versions" ("skill_id") WHERE "is_latest" = true;
CREATE UNIQUE INDEX "skill_versions_skill_version_idx" ON "agent"."skill_versions" ("skill_id", "version_number");
CREATE INDEX "skill_versions_tenant_idx" ON "agent"."skill_versions" ("tenant_id", "workspace_id");

------------------------------------------------------------
-- agent.background_tasks — durable Inngest run tracking
------------------------------------------------------------

CREATE TABLE "agent"."background_tasks" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "label" text,
  "inngest_run_id" text NOT NULL UNIQUE,
  "status" citext NOT NULL,
  "input_payload" jsonb NOT NULL,
  "result_payload" jsonb,
  "failure_reason" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "background_tasks_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX "background_tasks_tenant_status_idx" ON "agent"."background_tasks" ("tenant_id", "workspace_id", "status");
CREATE INDEX "background_tasks_tenant_idx" ON "agent"."background_tasks" ("tenant_id", "workspace_id");

------------------------------------------------------------
-- agent.approval_requests — mid-stream tool approval flow
------------------------------------------------------------

CREATE TABLE "agent"."approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  -- execution_step_id / tool_call_id / message_id cross schemas; FK omitted.
  "execution_step_id" uuid,
  "tool_call_id" uuid,
  "message_id" uuid NOT NULL,
  "capability_name" text NOT NULL,
  "input_preview" jsonb NOT NULL,
  "risk_level" citext NOT NULL,
  "resolution" citext,
  "resolved_at" timestamptz,
  "resolved_by_user_id" uuid,
  "note" text,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "approval_requests_risk_level_check"
    CHECK ("risk_level" IN ('low', 'medium', 'high')),
  CONSTRAINT "approval_requests_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('approved', 'denied', 'expired'))
);
CREATE INDEX "approval_requests_tenant_resolution_idx" ON "agent"."approval_requests" ("tenant_id", "workspace_id", "resolution");
CREATE INDEX "approval_requests_tenant_idx" ON "agent"."approval_requests" ("tenant_id", "workspace_id");
CREATE INDEX "approval_requests_message_idx" ON "agent"."approval_requests" ("message_id");

------------------------------------------------------------
-- agent.subagent_fanouts — parent aggregate
------------------------------------------------------------

CREATE TABLE "agent"."subagent_fanouts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "parent_message_id" uuid NOT NULL,
  "inngest_event_id" text,
  "status" citext NOT NULL,
  "total_children" integer NOT NULL,
  "completed_children" integer NOT NULL DEFAULT 0,
  CONSTRAINT "subagent_fanouts_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'partial', 'timed_out'))
);
CREATE INDEX "subagent_fanouts_tenant_idx" ON "agent"."subagent_fanouts" ("tenant_id", "workspace_id");
CREATE INDEX "subagent_fanouts_parent_message_idx" ON "agent"."subagent_fanouts" ("parent_message_id");

------------------------------------------------------------
-- agent.subagent_runs — per-child runs
------------------------------------------------------------

CREATE TABLE "agent"."subagent_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "fanout_id" uuid NOT NULL REFERENCES "agent"."subagent_fanouts"("id") ON DELETE CASCADE,
  "child_message_id" uuid NOT NULL,
  "capability_name" text NOT NULL,
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb,
  "status" citext NOT NULL,
  "error_reason" text,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "subagent_runs_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'failed'))
);
CREATE INDEX "subagent_runs_fanout_idx" ON "agent"."subagent_runs" ("fanout_id");
CREATE INDEX "subagent_runs_status_idx" ON "agent"."subagent_runs" ("status");

------------------------------------------------------------
-- agent.plan_steps — plan-mode steps tied to execution steps
------------------------------------------------------------

CREATE TABLE "agent"."plan_steps" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  -- execution_step_id references execution.execution_steps; FK omitted
  -- per CLAUDE.md storage boundaries (no cross-domain FKs).
  "execution_step_id" uuid NOT NULL,
  "plan_step_key" text NOT NULL,
  "summary" text NOT NULL,
  "intent" text NOT NULL,
  "capability_name" text,
  "input_preview" jsonb,
  "depends_on" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" citext NOT NULL,
  CONSTRAINT "plan_steps_status_check"
    CHECK ("status" IN ('pending', 'approved', 'denied', 'completed', 'failed'))
);
CREATE INDEX "plan_steps_tenant_idx" ON "agent"."plan_steps" ("tenant_id", "workspace_id");
CREATE INDEX "plan_steps_execution_step_idx" ON "agent"."plan_steps" ("execution_step_id");
CREATE INDEX "plan_steps_tenant_status_idx" ON "agent"."plan_steps" ("tenant_id", "workspace_id", "status");
