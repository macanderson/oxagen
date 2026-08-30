# Agent Execution

Archived spec & plan — PostgreSQL trace survives; Neo4j projection retired.

> **Status: Partially superseded (2026-07-21).** PostgreSQL execution, step,
> tool-call, and durable trace paths remain. The automatic Neo4j execution
> mirror, sync marker, and semantic peer-recall extension described below were
> retired for launch. Exact lineage belongs in a future immutable typed evidence
> ledger; this body remains only as historical implementation evidence.
>
> Core execution telemetry and recording infrastructure remains shipped through
> the three-table PostgreSQL schema with RLS, contracts, API/MCP routes, handlers,
> and durable trace reads. References below to Neo4j sync or
> `synced_to_graph_at` are no longer current.

**Implementation evidence**

- packages/database/src/schema/agent.ts:294 — agentExecutions table with originType polymorphism and synced_to_graph_at flag
- packages/database/src/schema/agent.ts:345 — agentExecutionSteps with claim/lease pattern (durable step retry)
- packages/database/src/schema/agent.ts:381 — agentToolCalls table with step FK
- packages/database/atlas/migrations/20260611233016_initial_schema.sql — baseline schema
- packages/database/atlas/migrations/20260612000959_add_agent_execution_step_timing.sql — step timing fields
- packages/oxagen/src/contracts/agent.execution.record.ts — contract with AGENT_EXECUTION_ORIGIN_TYPES enum (includes 'fanout')
- packages/oxagen/src/contracts/chat.message.execution.ts — chat integration contract
- apps/api/src/routes/v1/agent.execution.record.ts — route mounted in app.ts
- apps/mcp/src/tools/agent.execution.record.ts — MCP tool implementation
- apps/mcp/src/tools/chat.message.execution.ts — MCP tool implementation
- packages/handlers/src/agent.execution.record.ts — handler writes to all three tables + emits sync event
- packages/handlers/src/agent.execution.sync-event.ts — async Neo4j sync with embedding, terminal status check
- packages/handlers/src/chat.message.execution.ts — chat-to-execution link handler
- docs/capabilities/agent.execution.record.md — capability documentation
- docs/capabilities/chat.message.execution.md — capability documentation

**Known gaps at time of archive**

- ClickHouse execution_events table (append-only time-series store for audit/analytics)
- Dead schema cleanup: workflow.playbooks, workflow.playbook_versions, workflow.playbook_steps, event.triggers, integration.connections, content.documents, agent.tools still exist in baseline schema
- Migration 0015 (drop dead schemas) per implementation plan — only RLS policies updated in 20260612210000
- Neo4j graph node structure verification (TOUCHED_ENTITY, SPAWNED_EXECUTION, IN_CONVERSATION edges) — sync mechanism exists but topology not audited

**Source documents** (archived verbatim below)

- `docs/specs/agent-execution/design-spec.md`
- `docs/specs/agent-execution/implementation-plan.md`
- `docs/specs/agent-execution/workflow-runs-clarification.md`

## Spec — `design-spec.md`

## Agent Execution & Telemetry System Design Spec

**Version:** 1.0  
**Status:** APPROVED FOR IMPLEMENTATION  
**Date:** 2026-06-07  
**Owner:** Platform Team

---

### 1. Overview

#### Problem Statement

Today, agent invocations are fragmented across multiple systems:
- **Chat UI:** `chat.messages` (conversation-scoped, message-tree structure)
- **Observability:** No unified telemetry (tokens, latency, cost, status)
- **Knowledge graph:** No execution nodes or lineage (can't answer "what entities did this touch?")
- **Dead schemas:** 6 abandoned table groups (`execution.*`, `workflow.playbooks`, `event.triggers`, etc.) carry RLS overhead with zero usage

**Goal:** Unified agent execution telemetry across all dispatch origins (chat, event triggers, scheduled jobs, MCP requests, workflow orchestration) with:
1. Transactional accuracy for billing
2. Graph topology for knowledge discovery
3. Time-series analytics for trends

#### Scope

- ✅ Unified `agent_executions` table (canonical transactional record)
- ✅ Nested `agent_execution_steps` + `agent_tool_calls` (step-level detail)
- ✅ Neo4j mirror + ontology linkage (graph topology)
- ✅ ClickHouse append-only events (time-series analytics)
- ✅ Sunset all dead schemas (execution.*, workflow.playbooks, event.triggers, integration.connections, content.documents, agent.tools)
- ✅ Clarify relationship between `workflow_runs` (imperative orchestration) and new `agent_executions` (unified logging)
- ❌ Real-time Neo4j sync (async is acceptable)
- ❌ Modify chat.messages tree structure (keep as-is; agent_executions is a supplementary log)

---

### 2. Four-Store Model

Execution data lives across three stores (per CLAUDE.md infrastructure boundaries):

#### PostgreSQL (Primary Transactional Record)

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

#### Neo4j (Graph Topology & Lineage)

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

#### ClickHouse (Append-Only Time-Series)

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

### 3. Data Flow & Sync

#### Execution Lifecycle

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

#### Sync Strategy

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

#### Guarantees

| Store | Freshness | Consistency | Use Case |
|-------|-----------|-------------|----------|
| Postgres | Immediate | ACID | Billing, status, cost reconciliation |
| Neo4j | 5–30 sec | Eventual | Graph queries, entity discovery, lineage |
| ClickHouse | 5–10 min | Eventual | Trends, aggregates, audit (immutable) |

---

### 4. Workflow Context: `workflow_runs` vs. `agent_executions`

#### Relationship Clarity

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

#### Data Model

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

#### Queries

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

#### No Duplicity

`workflow_runs` and `agent_executions` serve complementary purposes:
- `workflow_runs` = **container** (orchestration plan, progress tracking)
- `agent_executions` = **telemetry log** (individual invocation data)

They are **not** redundant; they are **orthogonal**.

---

### 5. Dead Schema Sunset Plan

#### Tables to Drop

| Schema | Table(s) | Reason | Risk |
|--------|----------|--------|------|
| `execution` | executions, execution_steps, tool_calls | Playbook-tied, never wired; replaced by `agent_executions` | LOW — zero usage |
| `workflow` | playbooks, playbook_versions, playbook_steps | Templated workflows, never wired; capability deferred | LOW — zero usage |
| `event` | triggers | Event-driven rules; capability deferred | LOW — zero usage |
| `integration` | connections | Third-party connector auth; marketplace deferred | LOW — zero usage |
| `content` | documents | Workspace doc management; no semantic layer wired | LOW — zero usage |
| `agent` | tools | Tool catalog (static); discovery is dynamic from MCP | LOW — zero usage |

#### Sunset Execution Steps

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

### 6. Implementation Roadmap

#### Phase 1: Add New Execution Tables to Agent Schema (Migration 0014)

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

#### Phase 2: Drop Dead Schemas (Migration 0015)

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

#### Phase 3: Implement Execution Handlers (Handler Layer)

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

#### Phase 4: Neo4j Sync Worker (Async Mirroring)

**Deliverables:**
- ✅ Inngest function: `agent.sync-execution-to-graph`
- ✅ Retry logic (up to 24h, then alert)
- ✅ Entity inference (infer touched entities from conversation, tools, outputs)
- ✅ Relationship creation (execution → agent, → origin, → entities, → tools)

**Files:**
- New: `packages/inngest-functions/src/agent/sync-execution-to-graph.ts`
- Edit: `packages/database/src/schema/agent-executions.ts` (add `syncedToGraphAt` default logic)

#### Phase 5: ClickHouse Event Sink (Analytics)

**Deliverables:**
- ✅ ClickHouse table: `execution_events`
- ✅ Async event emitter → ClickHouse
- ✅ TTL = 2 years, partitioned by month

**Files:**
- New: `packages/telemetry/src/sinks/execution-events.ts`
- Edit: `packages/agent/src/handlers/record-execution.ts` (emit to ClickHouse)

#### Phase 6: API Routes & MCP Tools (Surface Layer)

**Deliverables:**
- ✅ `POST /api/v1/executions/{id}/status` — query execution status
- ✅ `GET /api/v1/executions?origin_type=chat&org_id=...` — list executions
- ✅ MCP tool: `agent.execution.list`
- ✅ MCP tool: `agent.execution.get`

**Files:**
- New: `apps/api/src/routes/v1/executions.ts`
- New: `apps/mcp/src/tools/agent-executions.ts`

---

### 7. Backward Compatibility

#### Chat Messages

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

#### Workflow Runs

**No breaking changes:**
- `workflow_runs` continues to track orchestration progress
- `workflow_runs` gains `origin_executions()` relationship to agent_executions
- Existing queries (progress tracking, status) unaffected

---

### 8. Success Criteria

- ✅ Migrations 0014 + 0015 apply cleanly on all CI lanes
- ✅ `pnpm typecheck` passes (no dangling imports)
- ✅ `pnpm test` passes (test coverage for new handlers)
- ✅ E2E verification: chat message → agent_executions record with correct origin_type, tokens, cost
- ✅ Neo4j sync worker: execution node created + relationships to agent, entities within 30s
- ✅ ClickHouse: execution_events row appended + queryable within 5 min
- ✅ Release audit: 0 dead tables, 9 tenant-scoped tables captured, execution schema deleted
- ✅ Cost reconciliation: `SUM(estimated_cost_usd)` from agent_executions matches billing rows

---

### 9. Rollback Plan

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

### 10. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Missing execution records (data loss) | LOW | CRITICAL | ACID guarantee in Postgres; verify in tests |
| Neo4j sync lag causes stale graph | MEDIUM | MEDIUM | Async acceptable; retry up to 24h; alerts |
| Cost miscalculation | LOW | CRITICAL | Dedicated cost reconciliation query; reconcile weekly |
| ClickHouse import fails (no audit trail) | LOW | LOW | Fire-and-forget; Postgres log is audit source |
| Existing code references dead tables | LOW | HIGH | Typecheck + grep before shipping |

---

### 11. References

- **CLAUDE.md**: Four-store model (§ Infrastructure boundaries)
- **Release Audit (2026-06-07)**: Dead schema findings
- **Agent Execution Design**: This document
- **Workflow Runs Schema**: `packages/database/src/schema/workflow-runs.ts`
- **Chat Messages Schema**: `packages/database/src/schema/chat.ts`

## Plan — `implementation-plan.md`

## Agent Execution System — Implementation Plan

**Status:** READY FOR EXECUTION  
**Duration:** ~2–3 sprints (6 developers, 2–3 weeks elapsed)  
**Blocking:** CI gates (migrations 0014–0015 required for all test runs)

---

### Work Breakdown

#### Epic 1: Database Schema & Migrations (3 sub-issues)

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

#### Epic 2: Execution Handlers & Instrumentation (5 sub-issues)

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

#### Epic 3: Neo4j Sync Worker (2 sub-issues)

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

#### Epic 4: ClickHouse Event Sink (1 sub-issue)

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

#### Epic 5: API & MCP Surface (2 sub-issues)

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

### Dependency Graph

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

### Execution Timeline

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

### Testing Strategy

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

### Rollout Strategy

1. **Staging:** Apply 0014, run all tests, verify execution flow
2. **Production:** Apply 0014 (no data loss risk; additive only)
3. **Cleanup:** Apply 0015 (drop dead tables) only after 7 days of production verification
4. **Backfill (optional):** If needed, reprocess chat.messages → agent_executions for historical data

## Document — `workflow-runs-clarification.md`

## Workflow Runs vs. Agent Executions — Clarification

**Status:** REFERENCE GUIDE  
**Updated:** 2026-06-07

---

### TL;DR

| Aspect | `agent.workflow_runs` | `agent.agent_executions` |
|--------|----------------------|-------------------------|
| **Purpose** | Orchestration container (plan tracking) | Unified execution log (telemetry) |
| **What it tracks** | Multi-task plan progress | Individual agent invocations |
| **Origin** | Imperative orchestration (plan-based) | All dispatch types (chat, event, schedule, MCP, workflow) |
| **Status** | planning\\|running\\|completed\\|failed\\|cancelled | planning\\|running\\|completed\\|failed\\|cancelled |
| **Key data** | `plan_json` (task structure), task counts | `input_tokens`, `output_tokens`, `estimated_cost_usd`, `latency_ms` |
| **Scope** | One per orchestration run | N per workflow_run (one per task executed) |
| **Billing** | No | Yes (canonical for cost reconciliation) |
| **Created by** | Plan phase (agent.plan) | Execution handlers (record-execution) |
| **Relationship** | Parent container | Child execution logs (origin_type='workflow_run', origin_id=workflow_run_id) |

---

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ Chat UI: User submits message                               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent processes request                                      │
│ - If "/plan" → agent generates a multi-step plan            │
│ - Creates: agent.workflow_runs row (plan container)         │
│ - For each task in plan:                                    │
│     └─ Invoke sub-agent → record agent_executions           │
└────────────────────┬────────────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
         ▼           ▼           ▼
    ┌────────┐  ┌────────┐  ┌────────┐
    │ Task 1 │  │ Task 2 │  │ Task 3 │
    │ (exec) │  │ (exec) │  │ (exec) │
    └────────┘  └────────┘  └────────┘
     
    Each task:
    - Spawns agent_executions with:
      origin_type = 'workflow_run'
      origin_id = <workflow_run_id>
      status, tokens, cost, etc.
```

---

### Data Models

#### workflow_runs (Imperative Orchestration Container)

```typescript
type WorkflowRun = {
  id: string; // "wfr-123"
  
  // Ownership
  orgId: string;
  workspaceId: string;
  
  // Plan definition
  title: string; // "Research competitor features"
  goal: string; // User's intent
  planJson: Array<Task>; // [
                         //   {stepNumber: 1, task: "...", type: "..."},
                         //   {stepNumber: 2, task: "...", dependencies: [1]},
                         // ]
  
  // Progress tracking
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  
  // Execution config
  maxParallelism: number; // default 50
  outputFormat: 'json' | 'csv';
  resultUrl?: string; // If result written to storage
  
  // Timing
  startedAt?: Date;
  completedAt?: Date;
  
  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdByUserId?: string;
};
```

**Query: Show orchestration progress**
```sql
SELECT id, title, status, completed_tasks, total_tasks 
FROM agent.workflow_runs 
WHERE org_id = $1 AND created_at > now() - interval '24h'
ORDER BY created_at DESC;
```

#### agent_executions (Unified Execution Telemetry)

```typescript
type AgentExecution = {
  id: string; // "aex-123"
  
  // Ownership
  orgId: string;
  workspaceId: string;
  
  // Agent identity
  agentId: string;
  agentVersionId: string;
  
  // Polymorphic origin
  originType: 'chat' | 'event_trigger' | 'scheduled_job' | 'mcp_request' | 'workflow_run';
  originId: string; // conversationId, triggerId, scheduleRunId, mcpRequestId, OR workflow_run_id
  
  // Execution state
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
  inputPayload: Record<string, unknown>;
  outputPayload?: Record<string, unknown>;
  failureReason?: string;
  
  // Telemetry (canonical for metering)
  startedAt?: Date;
  completedAt?: Date;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: Decimal; // Pulled from AI SDK response
  
  // Sync flag (for Neo4j mirror)
  syncedToGraphAt?: Date;
  
  // Audit
  createdAt: Date;
  updatedAt: Date;
  createdByUserId?: string;
};
```

**Query: Show all executions from a workflow run**
```sql
SELECT id, agent_id, status, estimated_cost_usd, input_tokens, output_tokens
FROM agent.agent_executions
WHERE origin_type = 'workflow_run' AND origin_id = $1
ORDER BY created_at ASC;

-- Total cost of orchestration
SELECT SUM(estimated_cost_usd) as total_cost
FROM agent.agent_executions
WHERE origin_type = 'workflow_run' AND origin_id = $1;
```

---

### No Duplicity — Complementary Roles

#### What workflow_runs Does
- Tracks the **plan structure** (`plan_json`): "Step 1: Research customer X → Step 2: Analyze results → Step 3: Generate report"
- Tracks **progress**: "2 of 3 tasks completed"
- Owns **orchestration metadata**: parallelism, output format, result URL
- **Not responsible for:** telemetry, cost, tokens, step-level detail

#### What agent_executions Does
- Captures **telemetry**: tokens, latency, cost for **each individual agent invocation**
- Enables **observability**: "Which agent ran? What did it cost? How long? What tokens?"
- Enables **analytics**: "Token usage by origin type this week"
- Enables **billing**: "Sum of all execution costs = customer bill"
- **Not responsible for:** plan structure, orchestration progress

#### They Are Orthogonal
```
workflow_runs = "The plan" (container)
agent_executions = "Execution ledger" (log)

workflow_runs is the "what should happen"
agent_executions is the "what actually happened + its cost"
```

---

### Example: `/plan` Request Flow

#### Step 1: User sends `/plan Build a pricing page`

```
Message: "Plan a pricing page" → Agent (planning phase)
```

#### Step 2: Agent generates a plan

```
Agent (Claude, planning) thinks:
"To build a pricing page, I should:
  1. Analyze competitor pricing pages
  2. Research user preferences from support tickets
  3. Generate a pricing strategy
  4. Draft the page copy"

Output:
{
  "type": "plan",
  "tasks": [
    {stepNumber: 1, task: "Analyze competitor pricing", type: "research", ...},
    {stepNumber: 2, task: "Research user preferences", type: "research", ...},
    {stepNumber: 3, task: "Generate strategy", type: "synthesis", ...},
    {stepNumber: 4, task: "Draft page", type: "generation", ...}
  ]
}
```

**Records:**
```
agent_executions (planning phase):
- id: aex-plan-001
- origin_type: 'chat'
- origin_id: <conversation_id>
- status: 'completed'
- agent: Claude (planner)
- input_tokens: 1240
- output_tokens: 340
- estimated_cost_usd: 0.0052
```

#### Step 3: Orchestration begins

```
workflow_runs (creation):
- id: wfr-456
- title: "Plan: Build a pricing page"
- goal: "Build a pricing page"
- plan_json: [task1, task2, task3, task4]
- status: 'running'
- totalTasks: 4
- completedTasks: 0
```

#### Step 4: Execute task 1 (in parallel with 2–3)

```
Agent spawned (Task 1: Analyze competitor pricing)
└─ Invokes: "Analyze Stripe, GitHub, Vercel pricing pages"

agent_executions (task 1 execution):
- id: aex-task1-001
- origin_type: 'workflow_run'  ← This is the link back to wfr-456
- origin_id: 'wfr-456'         ← Connect to the orchestration container
- status: 'completed'
- agent: Claude (researcher)
- input_tokens: 2100
- output_tokens: 1800
- estimated_cost_usd: 0.0156
```

#### Step 5: Execute tasks 2–3 (similar)

```
agent_executions:
- id: aex-task2-001
- origin_type: 'workflow_run'
- origin_id: 'wfr-456'
- status: 'completed'
- estimated_cost_usd: 0.0098

agent_executions:
- id: aex-task3-001
- origin_type: 'workflow_run'
- origin_id: 'wfr-456'
- status: 'completed'
- estimated_cost_usd: 0.0142
```

#### Step 6: Execute task 4 (generation)

```
Agent spawned (Task 4: Draft page)
└─ Invokes: "Generate pricing page copy and markdown"

agent_executions:
- id: aex-task4-001
- origin_type: 'workflow_run'
- origin_id: 'wfr-456'
- status: 'completed'
- estimated_cost_usd: 0.0234
```

#### Step 7: Orchestration completes

```
workflow_runs (completion):
- id: wfr-456
- status: 'completed'
- completedTasks: 4
- resultUrl: 'https://...' ← Generated artifacts

Metrics (from agent_executions):
SELECT SUM(estimated_cost_usd) FROM agent.agent_executions
WHERE origin_type = 'workflow_run' AND origin_id = 'wfr-456'
-- Total: 0.0052 + 0.0156 + 0.0098 + 0.0142 + 0.0234 = 0.0682
```

---

### Queries That Clarify the Relationship

**"What was the total cost of this orchestration?"**
```sql
SELECT SUM(ae.estimated_cost_usd) as total_cost
FROM agent.agent_executions ae
WHERE ae.origin_type = 'workflow_run' AND ae.origin_id = ?;
```

**"Show me all steps in this orchestration with their costs"**
```sql
SELECT 
  ae.id, 
  ae.status, 
  ae.estimated_cost_usd, 
  ae.input_tokens, 
  ae.output_tokens,
  ae.latency_ms
FROM agent.agent_executions ae
WHERE ae.origin_type = 'workflow_run' AND ae.origin_id = ?
ORDER BY ae.created_at ASC;
```

**"Which orchestrations had high costs?"**
```sql
SELECT 
  wr.id,
  wr.title,
  SUM(ae.estimated_cost_usd) as total_cost,
  COUNT(ae.id) as task_count
FROM agent.workflow_runs wr
LEFT JOIN agent.agent_executions ae 
  ON wr.id = ae.origin_id 
  AND ae.origin_type = 'workflow_run'
WHERE wr.org_id = ?
GROUP BY wr.id, wr.title
HAVING SUM(ae.estimated_cost_usd) > 0.05
ORDER BY total_cost DESC;
```

**"What entities did task 2 touch?"** (Graph query)
```cypher
MATCH (exec:Execution {id: "aex-task2-001"})
       -[:TOUCHED_ENTITY]-> (entity)
RETURN entity;
```

---

### Summary: No Conflict

| Dimension | workflow_runs | agent_executions |
|-----------|---------------|------------------|
| **Row per** | Orchestration | Agent invocation |
| **Cardinality** | 1 per `/plan` | 1 per task (many per workflow_run) |
| **Scope** | Plan structure + progress | Telemetry + cost |
| **Queried for** | "What's the plan status?" | "What did it cost? How many tokens?" |
| **Updated by** | Orchestrator (plan phase) | Execution handler (record-execution) |
| **Used for billing** | No (container, not execution) | Yes (canonical metering log) |

They form a **parent-child relationship**, not a conflict:
- workflow_runs = the orchestration container
- agent_executions with origin_type='workflow_run' = the execution ledger for that container

No tables are sunset. Both are kept, both are used, both serve essential roles.
