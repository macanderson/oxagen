# Workflow Runs Clarification

Archived spec & plan — status: partially shipped (audited 2026-07-03).

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The spec describes a separate agent.workflow_runs table with columns for plan tracking (totalTasks, completedTasks, failedTasks, planJson, etc.), but this table was never implemented. Instead, workflow runs are stored as agent_executions rows with origin_type='workflow_run', with metadata as jsonb in inputPayload. The workflow.run capability exists and functions, but the data model diverges from the spec's architecture.

**Implementation evidence**

- packages/database/src/schema/agent.ts — agentExecutions table exists with originType, originId, inputPayload columns (lines 295-346)
- packages/oxagen/src/contracts/workflow.run.ts — workflow.run contract exists; output documents that workflowId is 'Internal UUID of the agent_executions row (origin_type=workflow_run)' (lines 1-44)
- packages/handlers/src/workflow.run.ts — handler inserts into agentExecutions with originType='workflow_run' and stores metadata in inputPayload (lines 18-43)
- apps/api/src/routes/v1/workflow.ts — API route for workflow.run capability wired (lines 11-16)
- git log commit af3df15e (2026-06-08) — workflow-runs.ts schema file deleted as 'dead schema' with zero importers

**Known gaps at time of archive**

- agent.workflow_runs table in packages/database/src/schema/ (spec calls for separate table with id, orgId, workspaceId, title, goal, planJson, status, totalTasks, completedTasks, failedTasks, maxParallelism, outputFormat, resultUrl columns)
- Dedicated columns for workflow run progress tracking — totalTasks, completedTasks, failedTasks must be reconstructed from related agent_executions rows
- SQL query patterns described in spec (workflow_runs JOIN agent_executions) — spec's schema design not implemented

**Source documents** (archived verbatim below)

- `docs/specs/workflows/workflow_runs_clarification.md`

## Document — `workflow_runs_clarification.md`

## Workflow Runs vs. Agent Executions — Clarification

> **Authoritative document:** [`../agent-execution/workflow-runs-clarification.md`](../agent-execution/workflow-runs-clarification.md)
>
> This file is a focused summary at the canonical path. The full clarification
> (with data models, query patterns, and anti-patterns) lives in
> `agent-execution/workflow-runs-clarification.md`.

---

### TL;DR

| Aspect | `agent.workflow_runs` | `agent.agent_executions` |
|--------|----------------------|--------------------------|
| **Purpose** | Orchestration container (plan tracking) | Unified execution log (telemetry) |
| **What it tracks** | Multi-task plan progress | Individual agent invocations |
| **Origin** | Imperative orchestration (plan-based) | All dispatch types (chat, event, schedule, MCP, workflow) |
| **Key data** | `plan_json`, task counts | `input_tokens`, `output_tokens`, `estimated_cost_usd`, `latency_ms` |
| **Scope** | One per orchestration run | N per workflow_run (one per task executed) |
| **Billing** | No | Yes — canonical cost record |
| **Created by** | Plan phase (`agent.plan`) | `recordExecution()` handler |
| **Relationship** | Parent container | Child logs: `origin_type='workflow_run'`, `origin_id=<workflow_run_id>` |

---

### Why Two Tables?

`workflow_runs` was introduced with the workflow orchestration feature to track
imperative, multi-step plans. `agent_executions` is the *telemetry layer*:
it records the actual invocation cost, latency, and outcome regardless of what
triggered the agent. An execution always has one parent origin; a workflow_run
may spawn many executions.

Using `workflow_runs` for cost tracking or `agent_executions` for plan state would
violate the four-store model — each table has exactly one job.

---

### Relationship Diagram

```
agent.workflow_runs (one per orchestration run)
  id: uuid
  plan_json: jsonb          ← task structure, step list
  status: planning|running|completed|failed|cancelled
  total_tasks, completed_tasks, failed_tasks: int
  org_id, workspace_id (workspace-scoped RLS)
     │
     │  origin_type = 'workflow_run'
     │  origin_id   = workflow_runs.id
     │
     ├─► agent.agent_executions (one per agent invoked)
     │     id: uuid
     │     status, latency_ms, input_tokens, output_tokens, estimated_cost_usd
     │     synced_to_graph_at (Neo4j sync marker)
     │
     └─► agent.agent_execution_steps (one per step within an execution)
           └─► agent.agent_tool_calls (one per tool call within a step)
```

---

### Query Patterns

**List all executions for a workflow run:**
```sql
SELECT ae.*
FROM agent.agent_executions ae
WHERE ae.origin_type = 'workflow_run'
  AND ae.origin_id = :workflow_run_id
ORDER BY ae.created_at;
```

**Total cost for a workflow run:**
```sql
SELECT SUM(estimated_cost_usd) AS total_cost_usd
FROM agent.agent_executions
WHERE origin_type = 'workflow_run'
  AND origin_id = :workflow_run_id
  AND status = 'completed';
```

**List all workflow runs for a workspace (most recent first):**
```sql
SELECT wr.*, COUNT(ae.id) AS execution_count
FROM agent.workflow_runs wr
LEFT JOIN agent.agent_executions ae
  ON ae.origin_type = 'workflow_run' AND ae.origin_id = wr.id
WHERE wr.workspace_id = current_setting('app.current_workspace_id')::uuid
GROUP BY wr.id
ORDER BY wr.created_at DESC
LIMIT 50;
```

---

### Anti-Patterns

| Anti-pattern | Correct approach |
|-------------|-----------------|
| Reading `workflow_runs` to get token cost | Query `agent_executions` grouped by `origin_id` |
| Storing plan state in `agent_executions.input_payload` | Store plan JSON in `workflow_runs.plan_json` |
| Using `workflow_runs` for non-plan chat executions | Use `agent_executions` with `origin_type='chat'` |
| Storing Neo4j lineage in Postgres | Write execution node to Neo4j via the Inngest sync worker |

---

### Related

- Full clarification: [`../agent-execution/workflow-runs-clarification.md`](../agent-execution/workflow-runs-clarification.md)
- Execution spec: [`../execution/spec.md`](../execution/spec.md)
- Workflow schema: `packages/database/src/schema/workflow.ts`
- Agent schema: `packages/database/src/schema/agent.ts`
- Contracts: `packages/oxagen/src/contracts/agent.task.background.*.ts`

