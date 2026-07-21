# Agent Execution System — Implementation Plan

> **Launch update:** Phase 2's automatic Neo4j execution mirror was retired.
> Preserve the Postgres trace path; redesign graph lineage around typed run
> evidence rather than an eventually consistent duplicate.

> **Authoritative document:** [`../agent-execution/implementation-plan.md`](../agent-execution/implementation-plan.md)
>
> This file is a focused summary. The full plan with sprint breakdown and risk
> mitigations lives in `agent-execution/implementation-plan.md`.

---

## Phase 1 — recordExecution() Handler + Postgres Writes (in flight)

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

## Phase 2 — Inngest Worker: Neo4j Sync (in flight)

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

## Phase 3 — Execution UI (future)

Traces timeline, step tree, tool-call detail panel.  
Tracked in Linear. Not in current sprint.

---

## Phase 4 — Execution Analytics (future)

Agent performance dashboards, error pattern detection, cost attribution per agent.  
Tracked in Linear. Not in current sprint.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Neo4j unavailable during sync | Inngest retries (3x, exponential backoff); `synced_to_graph_at` NULL = not yet synced, not a failure |
| Execution row missing at step time | `recordExecution()` writes parent first, then steps in a single transaction |
| Large input/output payloads | Payloads >64 KB stored in Blob; Postgres row holds reference URL |
| RLS misconfiguration leaking cross-workspace data | CI manifest coverage test (`integration/manifest-coverage.test.ts`) asserts every `org_id` table appears in `POLICY_MANIFEST` |

---

## Related

- Design spec: [`spec.md`](./spec.md)
- Full plan: [`../agent-execution/implementation-plan.md`](../agent-execution/implementation-plan.md)
- Workflow runs clarification: [`../workflows/workflow_runs_clarification.md`](../workflows/workflow_runs_clarification.md)
