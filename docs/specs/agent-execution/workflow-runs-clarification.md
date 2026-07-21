# Workflow Runs vs. Agent Executions — Clarification

> **Launch update (2026-07-21):** PostgreSQL remains authoritative for execution telemetry. Automatic execution projection into Neo4j and its `synced_to_graph_at` flag have been retired; graph lineage must enter through explicit, typed evidence/citation flows.

**Status:** REFERENCE GUIDE  
**Updated:** 2026-06-07

---

## TL;DR

| Aspect | `agent.workflow_runs` | `agent.agent_executions` |
|--------|----------------------|-------------------------|
| **Purpose** | Orchestration container (plan tracking) | Unified execution log (telemetry) |
| **What it tracks** | Multi-task plan progress | Individual agent invocations |
| **Origin** | Imperative orchestration (plan-based) | All dispatch types (chat, event, schedule, MCP, workflow) |
| **Status** | planning\|running\|completed\|failed\|cancelled | planning\|running\|completed\|failed\|cancelled |
| **Key data** | `plan_json` (task structure), task counts | `input_tokens`, `output_tokens`, `estimated_cost_usd`, `latency_ms` |
| **Scope** | One per orchestration run | N per workflow_run (one per task executed) |
| **Billing** | No | Yes (canonical for cost reconciliation) |
| **Created by** | Plan phase (agent.plan) | Execution handlers (record-execution) |
| **Relationship** | Parent container | Child execution logs (origin_type='workflow_run', origin_id=workflow_run_id) |

---

## Architecture Diagram

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

## Data Models

### workflow_runs (Imperative Orchestration Container)

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

### agent_executions (Unified Execution Telemetry)

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

## No Duplicity — Complementary Roles

### What workflow_runs Does
- Tracks the **plan structure** (`plan_json`): "Step 1: Research customer X → Step 2: Analyze results → Step 3: Generate report"
- Tracks **progress**: "2 of 3 tasks completed"
- Owns **orchestration metadata**: parallelism, output format, result URL
- **Not responsible for:** telemetry, cost, tokens, step-level detail

### What agent_executions Does
- Captures **telemetry**: tokens, latency, cost for **each individual agent invocation**
- Enables **observability**: "Which agent ran? What did it cost? How long? What tokens?"
- Enables **analytics**: "Token usage by origin type this week"
- Enables **billing**: "Sum of all execution costs = customer bill"
- **Not responsible for:** plan structure, orchestration progress

### They Are Orthogonal
```
workflow_runs = "The plan" (container)
agent_executions = "Execution ledger" (log)

workflow_runs is the "what should happen"
agent_executions is the "what actually happened + its cost"
```

---

## Example: `/plan` Request Flow

### Step 1: User sends `/plan Build a pricing page`

```
Message: "Plan a pricing page" → Agent (planning phase)
```

### Step 2: Agent generates a plan

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

### Step 3: Orchestration begins

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

### Step 4: Execute task 1 (in parallel with 2–3)

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

### Step 5: Execute tasks 2–3 (similar)

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

### Step 6: Execute task 4 (generation)

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

### Step 7: Orchestration completes

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

## Queries That Clarify the Relationship

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

Entity provenance is not inferred from this telemetry row. It is represented separately by explicit, typed evidence/citation records when a producer can supply trustworthy lineage.

---

## Summary: No Conflict

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
