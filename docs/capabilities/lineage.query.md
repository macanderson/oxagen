# lineage.query

**Domain:** lineage
**Mode:** sync
**Scope:** org + workspace (org: Owner, Admin; workspace: Owner, Member, Viewer)
**Surfaces:** api, mcp, agent
**Risk level:** low
**Capability name:** `query_lineage`

## Intent

Return the **dispatch tree** rooted at one `agent.subagent_fanouts` row (a `dispatchId` returned by `dispatch_subagent`) — the data spine for the fleet-lineage explorer (issue #1078). Every subagent run reachable from that root is returned as a flat node, each carrying:

- its **principal** (who drove the run) and, when the principal is a delegated agent, its **delegation ceiling** (the invoking human whose authority bounds it) — resolved from Postgres `iam.principals`;
- observed **spend** (USD, tokens, LLM-call count) and **model/provider** — resolved from ClickHouse `token_usage`, joined on `execution_step_id = subagent_runs.child_message_id`;
- a derived **outcome** (`pending` / `running` / `completed` / `failed` / `cancelled`) that distinguishes a genuine failure from a cancellation, since the underlying `status` column has no `cancelled` value;
- an optional **delegationViolation** — see the honesty note below.

Read-only. The recursion spine mirrors `agent.subagent.dispatch`'s `countRootTreeDescendants`: a run's `child_message_id` becomes the next fan-out's `parent_message_id` when that run itself decomposed into its own dispatch.

## Input

| Field | Type | Notes |
|---|---|---|
| `dispatchId` | `string` | Public ID of the root fan-out (`agent.subagent_fanouts.publicId`) — the `dispatchId` returned by `dispatch_subagent`. |
| `maxDepth` | `number` | 1–10, default 5. A run dispatching its own subagents counts as one level. |
| `maxNodes` | `number` | 1–500, default 200. See `truncated` in the output. |

## Output

| Field | Type | Notes |
|---|---|---|
| `dispatchId` | `string` | Echoes the root fan-out's public id. |
| `rootStatus` | `"pending" \| "running" \| "completed" \| "partial" \| "timed_out"` | Raw status of the ROOT fan-out only — not per-run. Read each node's own `outcome` for run-level state. |
| `totalChildren` / `completedChildren` | `number` | Root fan-out counters. |
| `createdAt` / `updatedAt` | `string` (ISO 8601) | Root fan-out timestamps. |
| `nodes` | `LineageNode[]` | **Flat adjacency list**, not nested JSON — reconstruct the tree client-side via `parentRunId`. |
| `nodeCount` | `number` | `nodes.length`. |
| `truncated` | `boolean` | True when the tree has more runs than `maxNodes`. |
| `maxDepthReached` | `boolean` | True when a returned node at the deepest allowed depth still has its own `childFanoutId` — re-query with a larger `maxDepth` or with that id as the new `dispatchId`. |

### `LineageNode`

| Field | Type | Notes |
|---|---|---|
| `runId` | `string` | `subagent_runs.public_id`. |
| `fanoutId` | `string` | The dispatch batch this run belongs to — equals `dispatchId` at depth 0. |
| `parentRunId` | `string \| null` | The run whose own dispatch produced this node's batch; null at depth 0. |
| `childFanoutId` | `string \| null` | The batch THIS run itself spawned, whenever one exists — populated independent of whether that batch's own runs made it into this response. Check for a node with `parentRunId` equal to this `runId` to know whether they did; if not, re-query with this as the new `dispatchId`. Null only for a genuine leaf run. |
| `depth` | `number` | 0 = direct child of the root fan-out. |
| `capabilityName` | `string` | |
| `outcome` | `"pending" \| "running" \| "completed" \| "failed" \| "cancelled"` | Derived — never the raw `status` column. |
| `attempts` | `number` | Claim/lease cycles this run took. |
| `principal` | `{ id: string\|null; kind: "human"\|"agent"\|"service"\|null; displayName: string }` | `displayName` is always a real string — never a bare id. |
| `delegationCeiling` | `{ principalId: string; displayName: string } \| null` | Null unless the principal is a delegated agent with a resolvable human ceiling. |
| `model` / `provider` | `string \| null` | From `token_usage`; null when no usage rows are attributed to this run. |
| `spend` | `{ costUsd, inputTokens, outputTokens, llmCalls }` | `costUsd` is already converted from ClickHouse's micro-USD. |
| `delegationViolation` | `{ ruleId: string; message: string } \| null` | See below. |
| `startedAt` / `completedAt` / `durationMs` | `string\|null` / `string\|null` / `number\|null` | |

## `delegationViolation` — what actually populates it

Parsed from `subagent_runs.error_reason` matching the kernel's IAM-denial message shape (`IAM denied "<capability>" for principal: <reason>`, or the pending-approval message). **This can be non-null today** — it reflects any run that was authorization-denied.

It does **not** yet reflect the Agent-RBAC delegation-ceiling merge (`agent_delegation:*` in `packages/iam/src/check-iam.ts`) specifically: the subagent executor (`packages/inngest-functions/src/functions/agent.execute-subagent.ts`) builds its `CapabilityContext` without `ctx.agentRun`, so that resolution path never runs for subagent-dispatched capabilities, and no `agent_delegation:*` audit row is ever produced for them. When that wiring lands, this same field starts surfacing true delegation-ceiling outcomes with no shape change.

## Degradation

ClickHouse must never fail this read — a degraded telemetry store yields every node with `spend = 0`, `model`/`provider = null`, and `principal = { id: null, kind: null, displayName: "Unknown principal" }`, mirroring `billing.budget.get`'s spend-read degradation.

## Roles

Org: Owner, Admin. Workspace: Owner, Member, Viewer.

## Side effects

None — read only.
