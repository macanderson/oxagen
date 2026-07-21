# Agent Execution & Telemetry System Design Spec

> **Launch update (2026-07-21):** The automatic execution-to-Neo4j mirror described below is retired. PostgreSQL remains authoritative for execution state and telemetry; graph lineage is admitted only through explicit, typed evidence/citation flows. The mirror worker, event, mutation, vector index, and `synced_to_graph_at` flag no longer exist. The remainder of this document is retained as historical design context.

**Version:** 1.0  
**Status:** HISTORICAL — PARTIALLY SUPERSEDED
**Date:** 2026-06-07  
**Owner:** Platform Team

---

## 1. Overview

### Problem Statement

Today, agent invocations are fragmented across multiple systems:
- **Chat UI:** `chat.messages` (conversation-scoped, message-tree structure)
- **Observability:** No unified telemetry (tokens, latency, cost, status)
- **Knowledge graph:** No execution nodes or lineage (can't answer "what entities did this touch?")
- **Dead schemas:** 6 abandoned table groups (`execution.*`, `workflow.playbooks`, `event.triggers`, etc.) carry RLS overhead with zero usage

**Goal:** Unified agent execution telemetry across all dispatch origins (chat, event triggers, scheduled jobs, MCP requests, workflow orchestration) with:
1. Transactional accuracy for billing
2. Graph topology for knowledge discovery
3. Time-series analytics for trends

### Scope

- ✅ Unified `agent_executions` table (canonical transactional record)
- ✅ Nested `agent_execution_steps` + `agent_tool_calls` (step-level detail)
- ✅ Neo4j mirror + ontology linkage (graph topology)
- ✅ ClickHouse append-only events (time-series analytics)
- ✅ Sunset all dead schemas (execution.*, workflow.playbooks, event.triggers, integration.connections, content.documents, agent.tools)
- ✅ Clarify relationship between `workflow_runs` (imperative orchestration) and new `agent_executions` (unified logging)
- ❌ Real-time Neo4j sync (async is acceptable)
- ❌ Modify chat.messages tree structure (keep as-is; agent_executions is a supplementary log)

---

## 2. Four-Store Model

Execution data lives across three stores (per CLAUDE.md infrastructure boundaries):

### PostgreSQL (Primary Transactional Record)

**Purpose:** ACID-guaranteed execution state, billing source of truth

**Tables:**
```
agent.agent_executions (NEW)
├─ id (uuid, PK)
├─ org_id, workspace_id (org-scoped, RLS)
├─ agent_id, agent_version_id (FK)
├─ origin_type (enum: chat|event_trigger|scheduled_job|mcp_request|workflow_run)
├─ origin_id (uuid, polymorphic FK)
├─ status (planning|running|completed|failed|cancelled)
├─ input_payload, output_payload (jsonb)
├─ failure_reason (nullable)
├─ started_at, completed_at (timestamps)
├─ latency_ms (bigint)
├─ input_tokens, output_tokens (int, nullable)
├─ estimated_cost_usd (numeric(10,6), nullable)
├─ synced_to_graph_at (timestamp, nullable) ← sync flag
├─ created_at, updated_at, created_by_user_id (auditMixin)

agent.agent_execution_steps (NEW)
├─ id, execution_id (FK)
├─ step_number (int)
├─ step_type (tool_call|decision|retry|wait)
├─ status, input_payload, output_payload
├─ latency_ms, input_tokens, output_tokens
├─ failure_reason (nullable)

agent.agent_tool_calls (NEW)
├─ id, execution_step_id (FK)
├─ tool_name, tool_type (mcp|capability|builtin)
├─ request_payload, response_payload (jsonb)
├─ status, latency_ms, input_tokens, output_tokens
├─ created_at
```

**Indexes:**
- `agent_executions_org_idx` (org_id, workspace_id)
- `agent_executions_origin_idx` (origin_type, origin_id)
- `agent_executions_status_idx` (status)
- `agent_executions_agent_idx` (agent_id)
- `agent_execution_steps_execution_idx` (execution_id)
- `agent_tool_calls_step_idx` (execution_step_id)

**Query Patterns:**
```sql
-- "What was the cost of this execution?"
SELECT estimated_cost_usd, input_tokens, output_tokens 
FROM agent_executions 
WHERE id = $1 AND org_id = $2;

-- "Aggregate cost by origin type this week"
SELECT origin_type, SUM(estimated_cost_usd), COUNT(*)
FROM agent_executions
WHERE org_id = $1 AND created_at > now() - interval '7 days'
GROUP BY origin_type;

-- "Find all failed executions"
SELECT * FROM agent_executions
WHERE org_id = $1 AND status = 'failed'
ORDER BY created_at DESC LIMIT 100;
```

### Neo4j (Graph Topology & Lineage)

**Purpose:** Graph nodes + relationships for knowledge discovery, lineage, and ontology linkage

**Nodes & Relationships:**
```
// Primary execution node (mirrored from Postgres)
(:Execution {
  id: "aex-123",
  status: "completed",
  cost: 0.0052,
  inputTokens: 1240,
  outputTokens: 340,
  startedAt: ISO8601,
  completedAt: ISO8601,
  latencyMs: 12000
})

// Outbound edges from execution
[:INVOKED_AGENT] → (:Agent {id, name, slug})
[:ORIGINATED_FROM] → (:Message {id}) // if origin=chat
[:ORIGINATED_FROM] → (:EventTrigger {id}) // if origin=event_trigger
[:ORIGINATED_FROM] → (:ScheduleRun {id}) // if origin=scheduled_job
[:ORIGINATED_FROM] → (:MCPRequest {id}) // if origin=mcp_request
[:ORIGINATED_FROM] → (:WorkflowRun {id}) // if origin=workflow_run

// Ontology linkage (inferred or declared)
[:TOUCHED_ENTITY] → (:Entity {type: "Customer|Project|Feature|..."})

// Step-level structure
[:STEP] → (:ExecutionStep {number, status, latency})
  ├─ [:CALLED_TOOL] → (:Tool {name, type})
  └─ [:INVOKED_AGENT] → (:Agent) // sub-agent spawns

// Sub-execution lineage
[:SPAWNED_EXECUTION] → (:Execution) // parent → child

// Conversation lineage
[:IN_CONVERSATION] → (:Conversation {id})
```

**Query Patterns:**
```cypher
// "Which ontology entities were involved in this execution?"
MATCH (exec:Execution {id: "aex-123"})
       -[:TOUCHED_ENTITY]-> (entity)
RETURN entity.type, entity.id, entity.name;

// "Show execution lineage: what spawned this?"
MATCH path = (exec:Execution {id: "aex-123"})
       <-[:SPAWNED_EXECUTION*]-(root)
RETURN path;

// "All executions touching Customer X"
MATCH (cust:Customer {id: "cust-001"})
       <-[:TOUCHED_ENTITY]-(exec:Execution)
RETURN exec ORDER BY exec.startedAt DESC;

// "Dependency chain: message → execution → sub-agents → entities"
MATCH (msg:Message {id: "msg-abc"})
       <-[:ORIGINATED_FROM]-(exec:Execution)
       -[:SPAWNED_EXECUTION*]-> (child:Execution)
       -[:TOUCHED_ENTITY]-> (entity)
RETURN msg, exec, child, entity;
```

### ClickHouse (Append-Only Time-Series)

**Purpose:** Immutable event log for audit, analytics, and trend analysis

**Table:** `execution_events` (append-only)
```
execution_id (String)
org_id, workspace_id (UUID)
agent_id (UUID)
origin_type (enum)
origin_id (UUID)
status (enum)
started_at, completed_at (DateTime)
latency_ms (UInt32)
input_tokens, output_tokens (UInt32)
cost_usd (Decimal(10, 6))
step_count (UInt16)
tool_call_count (UInt16)
error_present (UInt8) // boolean
created_at (DateTime) → partitioned, TTL 2 years

PRIMARY KEY (org_id, created_at, execution_id)
ORDER BY (org_id, created_at)
PARTITION BY toYYYYMM(created_at)
```

**Query Patterns:**
```sql
-- "Token usage trend by origin (30 days)"
SELECT 
  date_trunc('day', created_at) as day,
  origin_type,
  SUM(output_tokens) as tokens,
  AVG(cost_usd) as avg_cost
FROM execution_events
WHERE org_id = 'org-123' AND created_at > now() - interval '30 days'
GROUP BY day, origin_type
ORDER BY day DESC;

-- "Execution count + error rate by agent"
SELECT 
  agent_id,
  COUNT(*) as executions,
  SUM(error_present) / COUNT(*) * 100 as error_rate_pct
FROM execution_events
WHERE org_id = 'org-123' AND created_at > now() - interval '7 days'
GROUP BY agent_id;
```

---

## 3. Data Flow & Sync

### Execution Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│ Dispatch Origin (Chat UI, Event Trigger, Schedule, MCP)      │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│ invoke() [AI SDK Boundary]                                    │
│ - Stream response to client (SSE for chat)                    │
│ - Collect: tokens, latency, tool calls, outputs              │
│ - Infer: touched entities (from context, tools, outputs)     │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│ Execution Complete (in-memory telemetry sealed)              │
│ - Calculate cost (via AI SDK model pricing)                  │
│ - Capture failure reason (if applicable)                     │
└────────────────────┬─────────────────────────────────────────┘
                     │
         ┌───────────┼───────────┬───────────┐
         │           │           │           │
         ▼           ▼           ▼           ▼
    ┌────────┐  ┌────────┐  ┌────────┐  ┌──────────┐
    │Postgres│  │ Neo4j  │  │ClickHouse │  │  Cache  │
    │(SYNC)  │  │(ASYNC) │  │ (ASYNC)   │  │(Memcache)
    └────────┘  └────────┘  └────────┘  └──────────┘
    
    WRITE:       ASYNC EMIT:  ASYNC EMIT:    SET TTL:
    - Record     - Exec node  - Event row    - Session
    - ACID lock  - Edges to   - Partitioned  - Lock
    - Metering     entities   - TTL=2yr      - Context
    boundary
    
    ┌─ Sync flag: synced_to_graph_at
    │  (retry if Neo4j failed)
    │
    └─ Retry logic:
       Cron job: "SELECT * FROM agent_executions 
                  WHERE synced_to_graph_at IS NULL 
                  AND created_at > now() - interval '24h'"
```

### Sync Strategy

1. **Postgres (synchronous, ACID):**
   - Handler calls `insertExecutionRecord({ ...telemetry })` at invoke() completion
   - Postgres write succeeds → execution is COMMITTED for billing
   - Set `synced_to_graph_at = NULL` initially

2. **Neo4j (asynchronous, best-effort):**
   - Publish event: `execution.created { id, ...metadata }`
   - Async worker (Inngest or cron) processes event
   - Create execution node + relationships
   - Update Postgres: `SET synced_to_graph_at = NOW()` on success
   - Retry failed syncs for 24 hours, then alert

3. **ClickHouse (asynchronous, fire-and-forget):**
   - Publish same event to ClickHouse sink
   - ClickHouse appends row (no backpressure; eventual consistency acceptable)
   - Audit trail is complete; analytics lag 5–10 min

### Guarantees

| Store | Freshness | Consistency | Use Case |
|-------|-----------|-------------|----------|
| Postgres | Immediate | ACID | Billing, status, cost reconciliation |
| Neo4j | 5–30 sec | Eventual | Graph queries, entity discovery, lineage |
| ClickHouse | 5–10 min | Eventual | Trends, aggregates, audit (immutable) |

---

## 4. Workflow Context: `workflow_runs` vs. `agent_executions`

### Relationship Clarity

**`agent.workflow_runs`** (Live, imperative orchestration container)
- Represents a multi-step orchestration plan (e.g., `/plan` output, multi-agent dispatch)
- Tracks progress: totalTasks, completedTasks, failedTasks
- Stores plan structure: `plan_json` (task definitions, dependencies)
- Status: planning|running|completed|failed|cancelled
- Owns execution context (max_parallelism, output_format)

**`agent.agent_executions`** (New, unified execution log)
- Represents individual agent invocations
- Captures telemetry: tokens, latency, cost, inputs/outputs
- Polymorphic origin (chat, event, schedule, mcp, **workflow_run**)
- Enables querying "all executions from this workflow_run"

### Data Model

```
agent.workflow_runs (container)
├─ id: "wfr-123"
├─ title: "Research competitor features"
├─ plan_json: [task1, task2, task3]
├─ status: "running"
├─ totalTasks: 3
├─ completedTasks: 1
└─ created_at, updated_at

    ↓ (linked via origin_id)

agent.agent_executions (individual invocations)
├─ id: "aex-a"
├─ origin_type: "workflow_run"
├─ origin_id: "wfr-123" ← links back
├─ status: "completed"
├─ estimated_cost_usd: 0.0042
├─ output_tokens: 240

├─ id: "aex-b"
├─ origin_type: "workflow_run"
├─ origin_id: "wfr-123"
├─ status: "running"
└─ ...

├─ id: "aex-c"
├─ origin_type: "workflow_run"
├─ origin_id: "wfr-123"
├─ status: "pending"
└─ ...
```

### Queries

```sql
-- "Show all executions from this workflow run"
SELECT * FROM agent_executions
WHERE origin_type = 'workflow_run' AND origin_id = 'wfr-123'
ORDER BY created_at;

-- "Total cost of a workflow run"
SELECT SUM(estimated_cost_usd) FROM agent_executions
WHERE origin_type = 'workflow_run' AND origin_id = 'wfr-123';

-- "Which workflow runs are still pending?"
SELECT wr.*, COUNT(ae.id) as pending_executions
FROM agent.workflow_runs wr
LEFT JOIN agent.agent_executions ae 
  ON wr.id = ae.origin_id 
  AND ae.origin_type = 'workflow_run'
  AND ae.status = 'pending'
WHERE wr.status IN ('planning', 'running')
GROUP BY wr.id
HAVING pending_executions > 0;
```

### No Duplicity

`workflow_runs` and `agent_executions` serve complementary purposes:
- `workflow_runs` = **container** (orchestration plan, progress tracking)
- `agent_executions` = **telemetry log** (individual invocation data)

They are **not** redundant; they are **orthogonal**.

---

## 5. Dead Schema Sunset Plan

### Tables to Drop

| Schema | Table(s) | Reason | Risk |
|--------|----------|--------|------|
| `execution` | executions, execution_steps, tool_calls | Playbook-tied, never wired; replaced by `agent_executions` | LOW — zero usage |
| `workflow` | playbooks, playbook_versions, playbook_steps | Templated workflows, never wired; capability deferred | LOW — zero usage |
| `event` | triggers | Event-driven rules; capability deferred | LOW — zero usage |
| `integration` | connections | Third-party connector auth; marketplace deferred | LOW — zero usage |
| `content` | documents | Workspace doc management; no semantic layer wired | LOW — zero usage |
| `agent` | tools | Tool catalog (static); discovery is dynamic from MCP | LOW — zero usage |

### Sunset Execution Steps

**Migration:** `0015_drop_dead_schemas.sql`

```sql
-- Drop schemas in dependency order
DROP SCHEMA IF EXISTS execution CASCADE;
-- execution.executions, execution.execution_steps, execution.tool_calls gone

-- Drop orphaned tables (not schema-scoped)
DROP TABLE IF EXISTS workflow.playbooks CASCADE;
DROP TABLE IF EXISTS workflow.playbook_versions CASCADE;
DROP TABLE IF EXISTS workflow.playbook_steps CASCADE;

DROP TABLE IF EXISTS event.triggers CASCADE;
DROP TABLE IF EXISTS integration.connections CASCADE;
DROP TABLE IF EXISTS content.documents CASCADE;
DROP TABLE IF EXISTS agent.tools CASCADE;

-- Clean up Drizzle relations
-- (relations.ts will have these entries removed)
```

**Code Changes:**

1. **Schema files (delete):**
   - ❌ `packages/database/src/schema/execution.ts`
   - ❌ `packages/database/src/schema/workflow.ts` (partial — keep workflow-runs.ts)

2. **Relations (edit `relations.ts`):**
   - ❌ Remove: `executionsRelations`, `executionStepsRelations`, `toolCallsRelations`
   - ❌ Remove: `playbooksRelations`, `playbookVersionsRelations`, `playbookStepsRelations`
   - ❌ Remove: `triggersRelations`
   - ❌ Remove: `connectionsRelations`
   - ❌ Remove: `documentsRelations`
   - ❌ Remove: `toolsRelations`

3. **Tenant Policy (edit `tenant-policy.manifest.ts`):**
   - ❌ Remove: `agent.tools`, `workflow.playbooks`, `event.triggers`, `execution.executions`, `content.documents`, `integration.connections`

4. **Schema Index (edit `schema/index.ts`):**
   - ❌ Remove exports: `executions`, `executionSteps`, `toolCalls`, `playbooks`, etc.

5. **TypeScript Cleanup:**
   - Run `pnpm typecheck` — no dangling imports
   - Search `packages/ --include="*.ts"` for references to dead tables; none should exist

---

## 6. Implementation Roadmap

### Phase 1: Add New Execution Tables to Agent Schema (Migration 0014)

**Deliverables:**
- ✅ `agent_executions` table (Postgres)
- ✅ `agent_execution_steps` table (Postgres)
- ✅ `agent_tool_calls` table (Postgres)
- ✅ RLS policies + tenant indexes
- ✅ Drizzle schema file: `packages/database/src/schema/agent-executions.ts`
- ✅ Relations definitions
- ✅ Tenant policy manifest entries

**Files:**
- New: `packages/database/src/migrations/0014_agent_executions.sql`
- New: `packages/database/src/schema/agent-executions.ts`
- Edit: `packages/database/src/schema/index.ts` (export new tables)
- Edit: `packages/database/src/relations.ts` (add new relations)
- Edit: `packages/database/src/tenant-policy.manifest.ts` (add 3 entries)

### Phase 2: Drop Dead Schemas (Migration 0015)

**Deliverables:**
- ✅ Clean drop of 6 table groups
- ✅ Schema cleanup (delete execution, truncate workflow)

**Files:**
- New: `packages/database/src/migrations/0015_drop_dead_schemas.sql`
- Delete: `packages/database/src/schema/execution.ts`
- Edit: `packages/database/src/schema/workflow.ts` (remove playbooks, keep workflow-runs)
- Delete: `packages/database/src/schema/index.ts` entries
- Edit: `packages/database/src/relations.ts` (remove dead relations)
- Edit: `packages/database/src/tenant-policy.manifest.ts` (remove dead entries)

### Phase 3: Implement Execution Handlers (Handler Layer)

**Deliverables:**
- ✅ `recordExecution()` function (insert agent_executions + steps + tool calls)
- ✅ Handler for chat message invocations
- ✅ Handler for event trigger invocations
- ✅ Handler for scheduled job invocations
- ✅ Handler for MCP request invocations
- ✅ Handler for workflow_run task invocations

**Files:**
- New: `packages/agent/src/handlers/record-execution.ts`
- New: `packages/agent/src/handlers/execution-chat.ts`
- New: `packages/agent/src/handlers/execution-event-trigger.ts`
- New: `packages/agent/src/handlers/execution-scheduled.ts`
- New: `packages/agent/src/handlers/execution-mcp.ts`
- New: `packages/agent/src/handlers/execution-workflow-run.ts`

### Phase 4: Neo4j Sync Worker (Async Mirroring)

**Deliverables:**
- ✅ Inngest function: `agent.sync-execution-to-graph`
- ✅ Retry logic (up to 24h, then alert)
- ✅ Entity inference (infer touched entities from conversation, tools, outputs)
- ✅ Relationship creation (execution → agent, → origin, → entities, → tools)

**Files:**
- New: `packages/inngest-functions/src/agent/sync-execution-to-graph.ts`
- Edit: `packages/database/src/schema/agent-executions.ts` (add `syncedToGraphAt` default logic)

### Phase 5: ClickHouse Event Sink (Analytics)

**Deliverables:**
- ✅ ClickHouse table: `execution_events`
- ✅ Async event emitter → ClickHouse
- ✅ TTL = 2 years, partitioned by month

**Files:**
- New: `packages/telemetry/src/sinks/execution-events.ts`
- Edit: `packages/agent/src/handlers/record-execution.ts` (emit to ClickHouse)

### Phase 6: API Routes & MCP Tools (Surface Layer)

**Deliverables:**
- ✅ `POST /api/v1/executions/{id}/status` — query execution status
- ✅ `GET /api/v1/executions?origin_type=chat&org_id=...` — list executions
- ✅ MCP tool: `agent.execution.list`
- ✅ MCP tool: `agent.execution.get`

**Files:**
- New: `apps/api/src/routes/v1/executions.ts`
- New: `apps/mcp/src/tools/agent-executions.ts`

---

## 7. Backward Compatibility

### Chat Messages

**No breaking changes:**
- `chat.messages` remains the source of truth for conversation threading
- `chat.messages` will optionally link to `agent_executions` via `message_id`
- Existing queries (history navigation, branching) unaffected

**Enhancement (non-breaking):**
```sql
-- Add to chat.messages (optional, for convenience)
ALTER TABLE chat.messages 
ADD COLUMN agent_execution_id uuid REFERENCES agent.agent_executions(id);

-- Index for fast lookup
CREATE INDEX messages_execution_idx ON chat.messages(agent_execution_id);
```

### Workflow Runs

**No breaking changes:**
- `workflow_runs` continues to track orchestration progress
- `workflow_runs` gains `origin_executions()` relationship to agent_executions
- Existing queries (progress tracking, status) unaffected

---

## 8. Success Criteria

- ✅ Migrations 0014 + 0015 apply cleanly on all CI lanes
- ✅ `pnpm typecheck` passes (no dangling imports)
- ✅ `pnpm test` passes (test coverage for new handlers)
- ✅ E2E verification: chat message → agent_executions record with correct origin_type, tokens, cost
- ✅ Neo4j sync worker: execution node created + relationships to agent, entities within 30s
- ✅ ClickHouse: execution_events row appended + queryable within 5 min
- ✅ Release audit: 0 dead tables, 9 tenant-scoped tables captured, execution schema deleted
- ✅ Cost reconciliation: `SUM(estimated_cost_usd)` from agent_executions matches billing rows

---

## 9. Rollback Plan

If neo4j sync fails extensively (>5% retry rate):
1. **Postgres side is unaffected** — agent_executions remains committed
2. **Pause Inngest sync-execution-to-graph function**
3. **Trigger alerts** (SLO breach)
4. **Manual reconciliation** later (Neo4j can be rebuilt from Postgres archive)

If execution schema drop fails:
1. Revert migrations 0014 + 0015
2. Re-apply 0015 with explicit dependency checks
3. Ensure no orphaned FKs remain

---

## 10. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Missing execution records (data loss) | LOW | CRITICAL | ACID guarantee in Postgres; verify in tests |
| Neo4j sync lag causes stale graph | MEDIUM | MEDIUM | Async acceptable; retry up to 24h; alerts |
| Cost miscalculation | LOW | CRITICAL | Dedicated cost reconciliation query; reconcile weekly |
| ClickHouse import fails (no audit trail) | LOW | LOW | Fire-and-forget; Postgres log is audit source |
| Existing code references dead tables | LOW | HIGH | Typecheck + grep before shipping |

---

## 11. References

- **CLAUDE.md**: Four-store model (§ Infrastructure boundaries)
- **Release Audit (2026-06-07)**: Dead schema findings
- **Agent Execution Design**: This document
- **Workflow Runs Schema**: `packages/database/src/schema/workflow-runs.ts`
- **Chat Messages Schema**: `packages/database/src/schema/chat.ts`
