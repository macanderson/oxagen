---
title: "Execution Layer"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially superseded** — PostgreSQL execution recording and durable
> trace reads remain. The automatic Neo4j execution mirror was retired for
> launch; the source material below is retained as historical design context.
>
> The Postgres tables (`agent_executions`, `agent_execution_steps`, and
> `agent_tool_calls`) remain the trace authority with workspace-scoped RLS.

**Implementation evidence**

- packages/database/src/schema/agent.ts — agentExecutions, agentExecutionSteps, agentToolCalls with indexes and constraints
- packages/database/atlas/migrations/20260611233016_initial_schema.sql — three execution tables created with RLS policies
- packages/handlers/src/agent.execution.record.ts — CapabilityHandler for recording executions with step and tool-call nesting
- packages/handlers/src/chat.message.execution.ts — Chat-origin execution recording wired into message flow
- packages/oxagen/src/contracts/agent.execution.record.ts — Contract with AGENT_EXECUTION_ORIGIN_TYPES enum including chat, event_trigger, scheduled_job, mcp_request, workflow_run, fanout
- apps/api/src/routes/v1/agent.execution.record.ts — REST POST route invoking record capability
- apps/api/src/routes/v1/chat.message.execution.ts — REST route for chat execution
- apps/mcp/src/tools/agent.execution.record.ts — MCP tool wrapper using same contract
- docs/capabilities/agent.execution.record.md — Capability documentation for the record endpoint

**Known gaps at time of archive**

- Dead schema sunset (migration 0015) — execution schema, workflow.playbooks, event.triggers, integration.connections, content.documents, agent.tools still in DB; code still references them (tenant-policy.manifest.ts)
- Event trigger execution handler (OXA-XXXX.6) — marked BLOCKED in implementation plan; no handler for origin_type=event_trigger
- Scheduled job execution handler (OXA-XXXX.7) — origin_type=scheduled_job not wired
- MCP request execution handler (OXA-XXXX.8) — origin_type=mcp_request not wired
- Typed immutable run-evidence ingest and projection are future work; the
  retired graph mirror is not a launch dependency.

**Source documents** (archived verbatim below)

- `docs/specs/execution/spec.md`
- `docs/specs/execution/plan.md`

## Spec — `spec.md`

## Agent Execution System — Design Spec

> **Authoritative document:** [`../agent-execution/design-spec.md`](../agent-execution/design-spec.md)
>
> This file is an index entry. The full specification lives in `agent-execution/design-spec.md`.

---

### Purpose

The agent execution system captures full execution context for every agent invocation
across all dispatch origins: chat, event triggers, scheduled jobs, MCP requests, and
workflow orchestration. It is the canonical source of truth for:

- **Billing**: `estimated_cost_usd` on `agent.agent_executions` is the per-invocation
  billing record. No other table is authoritative for token cost.
- **Observability**: `latency_ms`, `input_tokens`, `output_tokens`, `status`, and
  `failure_reason` feed the ops dashboard.
- **Knowledge graph**: Every completed execution is synced async to Neo4j via Inngest
  so the graph can answer "what entities did this invocation touch?"

---

### Data Model Summary

Three Postgres tables in the `agent` schema (migration 0019, workspace-scoped RLS):

```
agent.agent_executions
  id, org_id, workspace_id, agent_id, origin_type, origin_id
  status, input_payload, output_payload, failure_reason
  started_at, completed_at, latency_ms
  input_tokens, output_tokens, estimated_cost_usd
  synced_to_graph_at, created_at, updated_at, created_by_user_id

agent.agent_execution_steps
  id, execution_id → agent_executions.id
  step_number, step_type (tool_call|decision|retry|wait)
  status, input_payload, output_payload
  latency_ms, input_tokens, output_tokens, failure_reason

agent.agent_tool_calls
  id, execution_step_id → agent_execution_steps.id
  tool_name, tool_type (mcp|capability|builtin)
  request_payload, response_payload
  status, latency_ms, input_tokens, output_tokens
```

RLS scope: workspace-scoped (`org_id` + `workspace_id`) using the standard
`tenant_isolation` policy class from `tenant-policy.manifest.ts`.

---

### Event Flow

```
Caller (chat/event/schedule/mcp/workflow)
  │
  └─► recordExecution()                     ← packages/oxagen/src/handlers/
        │
        ├─► INSERT agent.agent_executions   ← Postgres (billing source of truth)
        ├─► INSERT agent.agent_execution_steps (per step)
        ├─► INSERT agent.agent_tool_calls   (per tool call)
        │
        └─► Inngest: agent/execution.sync   ← async, does not block caller
              │
              └─► Neo4j: CREATE (:Execution) node
                          + MERGE entity relationships
```

---

### Four-Store Placement

| Store       | What lives here                                                  |
|-------------|------------------------------------------------------------------|
| PostgreSQL  | `agent_executions`, `agent_execution_steps`, `agent_tool_calls` |
| Neo4j       | `:Execution` nodes, tool-call edges, entity relationships        |
| ClickHouse  | Append-only `execution_events` (time-series analytics)           |
| Blob        | Large input/output payloads (>64 KB); reference URL in Postgres  |

---

### Performance Characteristics

- **Append-only**: rows are never updated after completion (except `synced_to_graph_at`).
- **Indexes**: `(org_id, workspace_id)`, `(origin_type, origin_id)`, `status`,
  `agent_id`, `created_at DESC`.
- **Retention**: 90-day cold archive to Blob storage; hot Postgres rows kept for billing
  reconciliation and live dashboard queries.

---

### Related

- Full specification: [`../agent-execution/design-spec.md`](../agent-execution/design-spec.md)
- Implementation plan: [`plan.md`](./plan.md)
- Workflow runs clarification: [`../workflows/workflow_runs_clarification.md`](../workflows/workflow_runs_clarification.md)
- Contracts: `packages/oxagen/src/contracts/agent.task.background.*.ts`

## Plan — `plan.md`

## Agent Execution System — Implementation Plan

> **Authoritative document:** [`../agent-execution/implementation-plan.md`](../agent-execution/implementation-plan.md)
>
> This file is a focused summary. The full plan with sprint breakdown and risk
> mitigations lives in `agent-execution/implementation-plan.md`.

---

### Phase 1 — recordExecution() Handler + Postgres Writes (in flight)

**Status:** In progress  
**Deliverables:**
- `packages/oxagen/src/handlers/record-execution.ts` — `recordExecution(input)` function
- Writes `agent.agent_executions`, `agent_execution_steps`, `agent_tool_calls`
- Wired into the chat message path (`apps/api/src/routes/v1/chat.stream.ts`)
- Unit tests: ≥85% line, ≥80% branch coverage
- Contract: `packages/oxagen/src/contracts/agent.task.background.start.ts` references
  execution IDs

**Dependencies:**
- Migration 0019 (`agent_executions` schema) — completed
- RLS policies (standard workspace-scoped) — completed in migration 0019

---

### Phase 2 — Inngest Worker: Neo4j Sync (in flight)

**Status:** Pending (dispatched as task #6)  
**Deliverables:**
- `packages/inngest-functions/src/functions/agent.sync-execution-to-graph.ts` — Inngest function
- Consumes `agent/execution.sync` event
- Creates `(:Execution)` node in Neo4j
- Merges entity relationships (`TOUCHED_ENTITY`, `INVOKED_BY`, etc.)
- Sets `synced_to_graph_at` on the Postgres row after success
- Idempotent: re-running on the same execution_id is a no-op

**Dependencies:**
- Phase 1 (`recordExecution()` must emit the Inngest event)
- Neo4j schema: execution node label, tool-call relationship types

---

### Phase 3 — Execution UI (future)

Traces timeline, step tree, tool-call detail panel.  
Tracked in Linear. Not in current sprint.

---

### Phase 4 — Execution Analytics (future)

Agent performance dashboards, error pattern detection, cost attribution per agent.  
Tracked in Linear. Not in current sprint.

---

### Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Neo4j unavailable during sync | Inngest retries (3x, exponential backoff); `synced_to_graph_at` NULL = not yet synced, not a failure |
| Execution row missing at step time | `recordExecution()` writes parent first, then steps in a single transaction |
| Large input/output payloads | Payloads >64 KB stored in Blob; Postgres row holds reference URL |
| RLS misconfiguration leaking cross-workspace data | CI manifest coverage test (`integration/manifest-coverage.test.ts`) asserts every `org_id` table appears in `POLICY_MANIFEST` |

---

### Related

- Design spec: [`spec.md`](./spec.md)
- Full plan: [`../agent-execution/implementation-plan.md`](../agent-execution/implementation-plan.md)
- Workflow runs clarification: [`../workflows/workflow_runs_clarification.md`](../workflows/workflow_runs_clarification.md)
