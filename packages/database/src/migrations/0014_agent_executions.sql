-- Migration 0014: Add agent execution tables
-- Unified agent execution telemetry across all dispatch origins
-- (chat, event_trigger, scheduled_job, mcp_request, workflow_run)

-- Ensure agent schema exists
CREATE SCHEMA IF NOT EXISTS agent;

-- agent_executions: canonical execution record (transactional, ACID)
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

-- Indexes for common queries
CREATE INDEX agent_executions_org_idx
  ON agent.agent_executions(org_id, workspace_id);
CREATE INDEX agent_executions_origin_idx
  ON agent.agent_executions(origin_type, origin_id);
CREATE INDEX agent_executions_status_idx
  ON agent.agent_executions(status);
CREATE INDEX agent_executions_agent_idx
  ON agent.agent_executions(agent_id);
CREATE INDEX agent_executions_created_at_idx
  ON agent.agent_executions(created_at DESC);

-- RLS policies
ALTER TABLE agent.agent_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_executions_tenant_isolation
  ON agent.agent_executions
  USING (
    (current_setting('app.current_org_id')::uuid = org_id) OR
    EXISTS (
      SELECT 1 FROM iam.org_members om
      WHERE om.org_id = agent_executions.org_id
        AND om.user_id = auth.uid()
    )
  );

-- agent_execution_steps: step-level detail
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

CREATE INDEX agent_execution_steps_execution_idx
  ON agent.agent_execution_steps(execution_id);
CREATE INDEX agent_execution_steps_org_idx
  ON agent.agent_execution_steps(org_id, workspace_id);

ALTER TABLE agent.agent_execution_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_execution_steps_tenant_isolation
  ON agent.agent_execution_steps
  USING (
    (current_setting('app.current_org_id')::uuid = org_id) OR
    EXISTS (
      SELECT 1 FROM iam.org_members om
      WHERE om.org_id = agent_execution_steps.org_id
        AND om.user_id = auth.uid()
    )
  );

-- agent_tool_calls: tool invocation detail
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

CREATE INDEX agent_tool_calls_step_idx
  ON agent.agent_tool_calls(execution_step_id);
CREATE INDEX agent_tool_calls_tool_idx
  ON agent.agent_tool_calls(tool_name);
CREATE INDEX agent_tool_calls_org_idx
  ON agent.agent_tool_calls(org_id, workspace_id);

ALTER TABLE agent.agent_tool_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_calls_tenant_isolation
  ON agent.agent_tool_calls
  USING (
    (current_setting('app.current_org_id')::uuid = org_id) OR
    EXISTS (
      SELECT 1 FROM iam.org_members om
      WHERE om.org_id = agent_tool_calls.org_id
        AND om.user_id = auth.uid()
    )
  );
