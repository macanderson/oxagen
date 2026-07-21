# Agent Execution System — Design Spec

> **Launch update:** PostgreSQL execution, step, and tool-call records remain
> authoritative. The historical automatic Neo4j mirror described below was
> retired; typed immutable run evidence will be the source for any future
> coarse workspace-graph projection.

> **Authoritative document:** [`../agent-execution/design-spec.md`](../agent-execution/design-spec.md)
>
> This file is an index entry. The full specification lives in `agent-execution/design-spec.md`.

---

## Purpose

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

## Data Model Summary

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

## Event Flow

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

## Four-Store Placement

| Store       | What lives here                                                  |
|-------------|------------------------------------------------------------------|
| PostgreSQL  | `agent_executions`, `agent_execution_steps`, `agent_tool_calls` |
| Neo4j       | `:Execution` nodes, tool-call edges, entity relationships        |
| ClickHouse  | Append-only `execution_events` (time-series analytics)           |
| Blob        | Large input/output payloads (>64 KB); reference URL in Postgres  |

---

## Performance Characteristics

- **Append-only**: rows are never updated after completion (except `synced_to_graph_at`).
- **Indexes**: `(org_id, workspace_id)`, `(origin_type, origin_id)`, `status`,
  `agent_id`, `created_at DESC`.
- **Retention**: 90-day cold archive to Blob storage; hot Postgres rows kept for billing
  reconciliation and live dashboard queries.

---

## Related

- Full specification: [`../agent-execution/design-spec.md`](../agent-execution/design-spec.md)
- Implementation plan: [`plan.md`](./plan.md)
- Workflow runs clarification: [`../workflows/workflow_runs_clarification.md`](../workflows/workflow_runs_clarification.md)
- Contracts: `packages/oxagen/src/contracts/agent.task.background.*.ts`
