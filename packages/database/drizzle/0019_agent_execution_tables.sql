-- Create agent execution tables with correct RLS (OXA-1515)
-- Migration 0014 was in src/migrations/ (never executed by db-migrate) with broken
-- RLS predicates (iam.org_members doesn't exist; auth.uid() is Supabase-specific).
-- This migration creates the tables in drizzle/ with the standard bypass-aware RLS.

BEGIN;

-- agent.agent_executions: canonical execution record
CREATE TABLE agent.agent_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,

  -- Polymorphic origin: exactly one non-null enforced by CHECK
  origin_type text NOT NULL,
  origin_id uuid NOT NULL,

  -- Execution state
  status citext NOT NULL DEFAULT 'planning',
  input_payload jsonb NOT NULL,
  output_payload jsonb,
  failure_reason text,

  -- Telemetry (canonical for metering)
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(10, 6),

  -- Sync flag for Neo4j mirror
  synced_to_graph_at timestamp with time zone,

  -- Audit
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,

  CONSTRAINT agent_executions_status_check
    CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_executions_origin_type_check
    CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_executions_org_idx ON agent.agent_executions(org_id, workspace_id);
CREATE INDEX agent_executions_origin_idx ON agent.agent_executions(origin_type, origin_id);
CREATE INDEX agent_executions_status_idx ON agent.agent_executions(status);
CREATE INDEX agent_executions_agent_idx ON agent.agent_executions(agent_id);
CREATE INDEX agent_executions_created_at_idx ON agent.agent_executions(created_at DESC);

ALTER TABLE agent.agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_executions_tenant_isolation ON agent.agent_executions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- agent.agent_execution_steps: step-level detail
CREATE TABLE agent.agent_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES agent.agent_executions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,

  step_number integer NOT NULL,
  step_type text NOT NULL,
  status citext NOT NULL,

  input_payload jsonb NOT NULL,
  output_payload jsonb,
  failure_reason text,

  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,

  CONSTRAINT agent_execution_steps_step_type_check
    CHECK (step_type IN ('tool_call', 'decision', 'retry', 'wait')),
  CONSTRAINT agent_execution_steps_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_execution_steps_unique_per_execution
    UNIQUE (execution_id, step_number),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_execution_steps_execution_idx ON agent.agent_execution_steps(execution_id);
CREATE INDEX agent_execution_steps_org_idx ON agent.agent_execution_steps(org_id, workspace_id);

ALTER TABLE agent.agent_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_execution_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_execution_steps_tenant_isolation ON agent.agent_execution_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- agent.agent_tool_calls: tool invocation detail
CREATE TABLE agent.agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_step_id uuid NOT NULL REFERENCES agent.agent_execution_steps(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,

  tool_name text NOT NULL,
  tool_type text NOT NULL,

  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL,

  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,

  created_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT agent_tool_calls_tool_type_check
    CHECK (tool_type IN ('mcp', 'capability', 'builtin')),
  CONSTRAINT agent_tool_calls_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_tool_calls_step_idx ON agent.agent_tool_calls(execution_step_id);
CREATE INDEX agent_tool_calls_tool_idx ON agent.agent_tool_calls(tool_name);
CREATE INDEX agent_tool_calls_org_idx ON agent.agent_tool_calls(org_id, workspace_id);

ALTER TABLE agent.agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_calls_tenant_isolation ON agent.agent_tool_calls
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
