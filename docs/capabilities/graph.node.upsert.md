# graph.node.upsert

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low

## Intent

MERGE a KnowledgeNode in the graph. Creates or updates by externalId, or by a
natural key derived from label+displayName+workspaceId.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| label | string | User-defined node type, e.g. Person, Company, Topic (1-100 chars) |
| displayName | string | Human-readable name for the node (1-500 chars) |
| description | string? | Optional description or summary (max 2000 chars) (optional) |
| properties | object? | Arbitrary key-value metadata (optional) |
| externalId | string? | Stable user-supplied identifier for MERGE (max 500 chars); if absent, uses label+displayName+workspaceId (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| nodeId | string | publicId of the upserted node |
| created | boolean | True if newly created; false if updated |

## Side effects

Neo4j node created or updated. Audit trail in ClickHouse.

## Errors

None explicitly defined in the contract.
