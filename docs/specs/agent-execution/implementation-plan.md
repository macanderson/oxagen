# Agent Execution System — Implementation Plan

> **Launch update (2026-07-21):** The automatic execution-to-Neo4j mirror in this plan is retired. PostgreSQL remains authoritative for execution state and telemetry; graph lineage is admitted only through explicit, typed evidence/citation flows. The mirror worker, event, mutation, vector index, and `synced_to_graph_at` flag no longer exist. Tasks below are retained as historical planning context.

**Status:** HISTORICAL — PARTIALLY SUPERSEDED
**Duration:** ~2–3 sprints (6 developers, 2–3 weeks elapsed)  
**Blocking:** CI gates (migrations 0014–0015 required for all test runs)

---

## Work Breakdown

### Epic 1: Database Schema & Migrations (3 sub-issues)

**OXA-XXXX.1: Migration 0014 — Add Agent Execution Tables**

- **Effort:** M (1 day)
- **Assignee:** Database team lead
- **Deliverables:**
  - Create `packages/database/src/migrations/0014_agent_executions.sql`
  - Create `packages/database/src/schema/agent-executions.ts` (Drizzle definitions)
  - Update `packages/database/src/schema/index.ts` (export new tables)
  - Update `packages/database/src/relations.ts` (add new relations)
  - Update `packages/database/src/tenant-policy.manifest.ts` (3 new RLS policies)
  - Verify migration applies on fresh DB + existing DBs

**Acceptance Criteria:**
- `pnpm db:migrate` succeeds on CI DB
- `pnpm typecheck` passes (no TS errors)
- 3 new tables exist with correct columns + indexes
- RLS policies attached (all 3 tables have org-scoped FORCE RLS)
- `pnpm check:manifest` lists 3 new tenant-scoped tables

**Migration SQL (0014_agent_executions.sql):**
```sql
-- Create agent schema (if not exists)
CREATE SCHEMA IF NOT EXISTS agent;

-- agent_executions table
CREATE TABLE agent.agent_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,
  
  -- Polymorphic origin: exactly one non-null (CHECK enforced)
  origin_type text NOT NULL CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run')),
  origin_id uuid NOT NULL,
  
  -- Execution state
  status citext NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
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
  
  -- Sync flag (for Neo4j mirror)
  synced_to_graph_at timestamp with time zone,
  
  -- Audit
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  
  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agent.agents(id),
  FOREIGN KEY (agent_version_id) REFERENCES agent.agent_versions(id)
);

-- Indexes
CREATE INDEX agent_executions_org_idx ON agent.agent_executions(org_id, workspace_id);
CREATE INDEX agent_executions_origin_idx ON agent.agent_executions(origin_type, origin_id);
CREATE INDEX agent_executions_status_idx ON agent.agent_executions(status);
CREATE INDEX agent_executions_agent_idx ON agent.agent_executions(agent_id);
CREATE INDEX agent_executions_created_at_idx ON agent.agent_executions(created_at DESC);

-- RLS
ALTER TABLE agent.agent_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_executions_tenant_policy 
  ON agent.agent_executions 
  USING (EXISTS (
    SELECT 1 FROM iam.org_members om 
    WHERE om.org_id = agent_executions.org_id 
    AND om.user_id = current_user_id()
  ));

-- agent_execution_steps table
CREATE TABLE agent.agent_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES agent.agent_executions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  
  step_number integer NOT NULL,
  step_type text NOT NULL CHECK (step_type IN ('tool_call', 'decision', 'retry', 'wait')),
  status citext NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  
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
  
  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE,
  UNIQUE (execution_id, step_number)
);

CREATE INDEX agent_execution_steps_execution_idx ON agent.agent_execution_steps(execution_id);
CREATE INDEX agent_execution_steps_org_idx ON agent.agent_execution_steps(org_id, workspace_id);

ALTER TABLE agent.agent_execution_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_execution_steps_tenant_policy 
  ON agent.agent_execution_steps 
  USING (EXISTS (
    SELECT 1 FROM iam.org_members om 
    WHERE om.org_id = agent_execution_steps.org_id 
    AND om.user_id = current_user_id()
  ));

-- agent_tool_calls table
CREATE TABLE agent.agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_step_id uuid NOT NULL REFERENCES agent.agent_execution_steps(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  
  tool_name text NOT NULL,
  tool_type text NOT NULL CHECK (tool_type IN ('mcp', 'capability', 'builtin')),
  
  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  
  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,
  
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  
  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_tool_calls_step_idx ON agent.agent_tool_calls(execution_step_id);
CREATE INDEX agent_tool_calls_tool_idx ON agent.agent_tool_calls(tool_name);
CREATE INDEX agent_tool_calls_org_idx ON agent.agent_tool_calls(org_id, workspace_id);

ALTER TABLE agent.agent_tool_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_calls_tenant_policy 
  ON agent.agent_tool_calls 
  USING (EXISTS (
    SELECT 1 FROM iam.org_members om 
    WHERE om.org_id = agent_tool_calls.org_id 
    AND om.user_id = current_user_id()
  ));
```

---

**OXA-XXXX.2: Migration 0015 — Drop Dead Schemas & Tables**

- **Effort:** S (2–4 hours)
- **Assignee:** Database team
- **Dependencies:** OXA-XXXX.1 (migration 0014 applied)
- **Deliverables:**
  - `packages/database/src/migrations/0015_drop_dead_schemas.sql`
  - Delete `packages/database/src/schema/execution.ts`
  - Edit `packages/database/src/schema/workflow.ts` (remove playbooks, versions, steps)
  - Update `packages/database/src/relations.ts` (remove 6 dead relations)
  - Update `packages/database/src/tenant-policy.manifest.ts` (remove 6 entries)
  - Update `packages/database/src/schema/index.ts` (remove exports)
  - Verify no dangling imports (`pnpm typecheck`)

**Acceptance Criteria:**
- `pnpm db:migrate` succeeds (drop succeeds, no cascade errors)
- `pnpm typecheck` passes (zero references to dead tables)
- `grep -r "executions\|playbooks\|triggers\|connections\|documents\|agent.tools" packages --include="*.ts" | grep -v "node_modules\|dist"` returns nothing
- `pnpm check:manifest` lists 0 dead tables

**Migration SQL (0015_drop_dead_schemas.sql):**
```sql
-- Drop execution schema entirely
DROP SCHEMA IF EXISTS execution CASCADE;

-- Drop orphaned tables
DROP TABLE IF EXISTS workflow.playbooks CASCADE;
DROP TABLE IF EXISTS workflow.playbook_versions CASCADE;
DROP TABLE IF EXISTS workflow.playbook_steps CASCADE;

DROP TABLE IF EXISTS event.triggers CASCADE;
DROP TABLE IF EXISTS integration.connections CASCADE;
DROP TABLE IF EXISTS content.documents CASCADE;
DROP TABLE IF EXISTS agent.tools CASCADE;

-- (Dangling indexes will be auto-dropped by CASCADE)
```

---

**OXA-XXXX.3: TypeScript Schema & Relations Updates**

- **Effort:** S (4 hours)
- **Assignee:** Database team / backend engineer
- **Dependencies:** OXA-XXXX.1
- **Deliverables:**
  - `packages/database/src/schema/agent-executions.ts` (Drizzle definitions)
  - Update `packages/database/src/schema/index.ts` (export new tables)
  - Update `packages/database/src/relations.ts` (add relations, remove dead)
  - Update `packages/database/src/tenant-policy.manifest.ts` (add 3, remove 6)
  - All new functions have JSDoc with parameter types + return types
  - Tests exist: verify tables are exported + accessible via `db()` queries

**Key Code:**

```typescript
// packages/database/src/schema/agent-executions.ts
import { bigint, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentSchema } from "./_schemas";
import { auditMixin, citext, idMixin, orgScopeMixin } from "./_mixins";

export const agentExecutions = agentSchema.table("agent_executions", {
  ...idMixin("aex"),
  ...auditMixin(),
  ...orgScopeMixin(),
  agentId: uuid("agent_id").notNull(),
  agentVersionId: uuid("agent_version_id").notNull(),
  originType: citext("origin_type").notNull(),
  originId: uuid("origin_id").notNull(),
  status: citext("status").notNull().default("planning"),
  inputPayload: jsonb("input_payload").notNull(),
  outputPayload: jsonb("output_payload"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  latencyMs: bigint("latency_ms", { mode: "bigint" }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  estimatedCostUsd: text("estimated_cost_usd"), // numeric serialized as string for JSON compat
  syncedToGraphAt: timestamp("synced_to_graph_at", { withTimezone: true, mode: "date" }),
}, (t) => ({
  orgIdx: index("agent_executions_org_idx").on(t.orgId, t.workspaceId),
  originIdx: index("agent_executions_origin_idx").on(t.originType, t.originId),
  statusIdx: index("agent_executions_status_idx").on(t.status),
  agentIdx: index("agent_executions_agent_idx").on(t.agentId),
  createdAtIdx: index("agent_executions_created_at_idx").on(t.createdAt),
}));

export const agentExecutionSteps = agentSchema.table("agent_execution_steps", {
  ...idMixin("aes"),
  ...auditMixin(),
  ...orgScopeMixin(),
  executionId: uuid("execution_id").notNull(),
  stepNumber: integer("step_number").notNull(),
  stepType: citext("step_type").notNull(),
  status: citext("status").notNull(),
  inputPayload: jsonb("input_payload").notNull(),
  outputPayload: jsonb("output_payload"),
  failureReason: text("failure_reason"),
  latencyMs: bigint("latency_ms", { mode: "bigint" }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
}, (t) => ({
  executionIdx: index("agent_execution_steps_execution_idx").on(t.executionId),
  orgIdx: index("agent_execution_steps_org_idx").on(t.orgId, t.workspaceId),
  uniqueStepIdx: sql`UNIQUE (${t.executionId}, ${t.stepNumber})`,
}));

export const agentToolCalls = agentSchema.table("agent_tool_calls", {
  ...idMixin("atc"),
  ...orgScopeMixin(),
  executionStepId: uuid("execution_step_id").notNull(),
  toolName: text("tool_name").notNull(),
  toolType: citext("tool_type").notNull(),
  requestPayload: jsonb("request_payload").notNull(),
  responsePayload: jsonb("response_payload"),
  status: text("status").notNull(),
  latencyMs: bigint("latency_ms", { mode: "bigint" }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .default(sql`now()`),
}, (t) => ({
  stepIdx: index("agent_tool_calls_step_idx").on(t.executionStepId),
  toolIdx: index("agent_tool_calls_tool_idx").on(t.toolName),
  orgIdx: index("agent_tool_calls_org_idx").on(t.orgId, t.workspaceId),
}));
```

---

### Epic 2: Execution Handlers & Instrumentation (5 sub-issues)

**OXA-XXXX.4: Record Execution Handler Function**

- **Effort:** M (4–6 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.1
- **Deliverables:**
  - `packages/agent/src/handlers/record-execution.ts`
  - Exports: `recordExecution(exec)` function
  - Inserts agent_executions + agent_execution_steps + agent_tool_calls in transaction
  - Calculates `estimatedCostUsd` from token counts (use billing.pricing.ts)
  - Returns recorded execution ID + sync flag
  - Proper error handling (transaction rollback on failure)
  - Unit tests (mock DB, verify row counts + field values)

**Function Signature:**
```typescript
/**
 * Record a completed agent execution to the canonical log.
 * ACID-guaranteed; failure means execution is NOT recorded for billing.
 * 
 * @param context - Execution context (org, workspace, user)
 * @param execution - Execution metadata (agent, origin, status, tokens, outputs)
 * @returns recorded execution ID + synced_to_graph_at flag
 */
async function recordExecution(
  context: ExecutionContext,
  execution: ExecutionTelemetry
): Promise<{ executionId: string; syncedToGraphAt: Date | null }>;
```

---

**OXA-XXXX.5: Execution Handler — Chat Messages**

- **Effort:** M (6–8 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.4
- **Deliverables:**
  - Hook: `POST /api/v1/chat/stream` completion → call `recordExecution()`
  - Extract: conversationId, messageId, origin_type='chat'
  - Infer touched entities from message content + tools called
  - Emit: execution.created event (for Neo4j + ClickHouse)
  - Test: verify execution record has correct origin_type, origin_id, tokens, cost

---

**OXA-XXXX.6: Execution Handler — Event Triggers**

- **Effort:** L (8–10 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.4, Event trigger infrastructure
- **Status:** BLOCKED (event triggers not yet wired)
- **Deliverables:**
  - Hook: Event trigger fired → invoke agent → record execution
  - origin_type='event_trigger', origin_id=trigger_id
  - Test: mock trigger, verify execution record

---

**OXA-XXXX.7: Execution Handler — Scheduled Jobs**

- **Effort:** L (8–10 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.4
- **Deliverables:**
  - Hook: Schedule job execution (Inngest) → invoke agent → record execution
  - origin_type='scheduled_job', origin_id=schedule_run_id
  - Test: mock schedule, verify execution record

---

**OXA-XXXX.8: Execution Handler — MCP Requests**

- **Effort:** M (6–8 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.4
- **Deliverables:**
  - Hook: MCP request → invoke agent → record execution
  - origin_type='mcp_request', origin_id=mcp_request_id
  - Test: mock MCP call, verify execution record

---

### Epic 3: Neo4j Sync Worker (2 sub-issues)

**OXA-XXXX.9: Inngest Function — Sync Execution to Graph**

- **Effort:** L (10–12 hours)
- **Assignee:** Backend engineer + Neo4j expert
- **Dependencies:** OXA-XXXX.4
- **Deliverables:**
  - Inngest function: `agent.sync-execution-to-graph`
  - Triggered by: `execution.created` event
  - Creates execution node + relationships to agent, origin, entities, tools
  - Infers touched entities from conversation context, tools called, output analysis
  - Retry logic: exponential backoff, up to 24h
  - Alerts if sync fails (SLO breach)
  - Updates `synced_to_graph_at` in Postgres on success
  - Test: mock Neo4j, verify node creation + relationships

---

**OXA-XXXX.10: Cron Job — Retry Unsync'd Executions**

- **Effort:** S (2–4 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.9
- **Deliverables:**
  - Daily cron: Find `WHERE synced_to_graph_at IS NULL AND created_at > now() - interval '24h'`
  - Re-trigger sync for up to 10 oldest rows
  - Alert if retries exceed threshold

---

### Epic 4: ClickHouse Event Sink (1 sub-issue)

**OXA-XXXX.11: Event Sink — Execution Events to ClickHouse**

- **Effort:** M (4–6 hours)
- **Assignee:** Data / telemetry engineer
- **Dependencies:** OXA-XXXX.4
- **Deliverables:**
  - ClickHouse table: `default.execution_events` (append-only)
  - Async emitter: emit from `execution.created` event
  - Partition by month, TTL 2 years
  - Test: mock ClickHouse, verify row appended + queryable

---

### Epic 5: API & MCP Surface (2 sub-issues)

**OXA-XXXX.12: REST API Routes — Execution Queries**

- **Effort:** M (4–6 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.1
- **Deliverables:**
  - `GET /api/v1/executions?org_id=...&origin_type=...&limit=100`
  - `GET /api/v1/executions/{id}`
  - `GET /api/v1/executions?origin_type=workflow_run&origin_id={wfr-id}` (query all executions from a workflow)
  - Proper filtering + pagination
  - Test: verify queries return correct rows

---

**OXA-XXXX.13: MCP Tools — Agent Executions**

- **Effort:** M (4–6 hours)
- **Assignee:** Backend engineer
- **Dependencies:** OXA-XXXX.1
- **Deliverables:**
  - `agent.execution.list` — list executions by org/origin
  - `agent.execution.get` — fetch single execution with steps + tool calls
  - Test: verify MCP tool responses match API

---

## Dependency Graph

```
0014 [DB Migration]
├─ OXA-XXXX.1 (CREATE tables)
├─ OXA-XXXX.3 (TypeScript)
├─ OXA-XXXX.4 (Handler)
│  ├─ OXA-XXXX.5 (Chat)
│  ├─ OXA-XXXX.6 (Event Trigger) *BLOCKED
│  ├─ OXA-XXXX.7 (Scheduled)
│  ├─ OXA-XXXX.8 (MCP)
│  ├─ OXA-XXXX.9 (Neo4j Sync)
│  │  └─ OXA-XXXX.10 (Retry Cron)
│  ├─ OXA-XXXX.11 (ClickHouse)
│  ├─ OXA-XXXX.12 (API Routes)
│  └─ OXA-XXXX.13 (MCP Tools)

0015 [DB Migration]
└─ OXA-XXXX.2 (DROP dead tables)
   └─ All OXA-XXXX.4+ (no dependency; can run in parallel after 0014)
```

---

## Execution Timeline

**Week 1:**
- Mon: OXA-XXXX.1 + OXA-XXXX.3 (DB + TS schema)
- Tue–Wed: OXA-XXXX.4 (record handler)
- Thu: OXA-XXXX.5 (chat handler)
- Fri: OXA-XXXX.2 (drop dead tables) — ONLY if OXA-XXXX.1–3 green

**Week 2:**
- Mon–Tue: OXA-XXXX.7 + OXA-XXXX.8 (handlers in parallel)
- Wed–Thu: OXA-XXXX.9 + OXA-XXXX.10 (Neo4j sync)
- Fri: OXA-XXXX.11 (ClickHouse sink)

**Week 3:**
- Mon–Tue: OXA-XXXX.12 + OXA-XXXX.13 (API + MCP)
- Wed–Fri: Integration testing + edge cases

---

## Testing Strategy

**Unit:**
- Record handler: insert correctness, cost calculation, error rollback
- Handlers (chat, event, etc.): payload extraction, origin_id correctness
- Neo4j sync: node creation, relationship cardinality
- ClickHouse: event structure, partitioning

**Integration:**
- Full flow: chat message → record → Neo4j sync → ClickHouse append
- Cost reconciliation: sum(estimated_cost_usd) matches billing rows
- Query: List executions by origin_type, filter by status, paginate

**E2E:**
- Send message → check agent_executions row exists with correct cost
- Wait 30s → check Neo4j node exists
- Wait 5 min → check ClickHouse row appended + queryable

---

## Rollout Strategy

1. **Staging:** Apply 0014, run all tests, verify execution flow
2. **Production:** Apply 0014 (no data loss risk; additive only)
3. **Cleanup:** Apply 0015 (drop dead tables) only after 7 days of production verification
4. **Backfill (optional):** If needed, reprocess chat.messages → agent_executions for historical data
