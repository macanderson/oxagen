# get_execution_lineage

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Get one agent execution's **file-level lineage** as a graph — the `:Execution`
node plus every `:SourceFile` it touched via `(:Execution)-[:TOUCHED_FILE]->
(:SourceFile)` edges (written by
`packages/ontology/src/mutations/record-execution.ts`, invoked from the
durable execution-sync path).

This is the auditable-graph proof, not a flat "files this agent said it
edited" list: it is the real, queryable graph of what an execution actually
touched — the same lineage a customer can inspect and cite. Both the
execution and each touched file are resolved server-side to the shared
`KnowledgeNodeRef` shape (`{ id, label, displayName, properties }`) so the UI
cites them by human label with an inspectable property bag on the shared
knowledge-graph canvas — never a bare UUID (see CLAUDE.md "Citing nodes &
edges").

The `:Execution` is matched within the caller's org + workspace; its
`:SourceFile` neighbours are org-scoped (a source file is shared across an
org's workspaces for the same repo) and are reached only via the
tenant-scoped execution's edges.

## Input

| Field | Type | Notes |
|---|---|---|
| `executionId` | `string` | `publicId` / id of the `:Execution` graph node whose lineage to fetch. |

## Output

| Field | Type | Notes |
|---|---|---|
| `found` | `boolean` | `true` if the execution exists as a node in this org + workspace. |
| `execution` | `KnowledgeNodeRef \| null` | The execution node, resolved to a citable ref; `null` when not found. |
| `files` | `{ node: KnowledgeNodeRef, edgeType: string }[]` | Every source file this execution touched, with its `TOUCHED_FILE` edge type. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

None — read-only (Neo4j graph read).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |

## Surfaces

- **API:** `GET /v1/{org}/{ws}/agent/executions/lineage/{executionId}`
- **MCP:** tool defined in `apps/mcp/src/tools/agent.execution.lineage.ts`
- **Agent:** no approval required, risk `low`, category `introspection`.

## Related

- [agent.execution.list](agent.execution.list.md) — list top-level executions (the Activity index this lineage view expands from).
- [agent.trace.get](agent.trace.get.md) (`get_execution_trace`) — the step/tool-call span tree for the same execution.
