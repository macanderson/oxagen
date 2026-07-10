# graph.edge.upsert

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low

## Intent

MERGE a typed relationship between two KnowledgeNodes. Edge type must be one
of the allowed relationship types.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fromNodeId | string | publicId of the source KnowledgeNode |
| toNodeId | string | publicId of the target KnowledgeNode |
| relationshipType | string | Relationship type — must match `[A-Z][A-Z0-9_]{0,62}` (open vocabulary, not a fixed enum) |
| properties | object? | Optional string key-value metadata for the relationship (optional) |
| observedAt | string? (ISO-8601) | Valid time of the fact; omit to stamp `validFrom = now` |
| supersede | boolean? | Close any other currently-open edge of the same type from the source (preserving history). Default false. |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| edgeId | string | Composite identifier: fromNodeId:relationshipType:toNodeId |
| created | boolean | True if newly created; false if already existed |
| superseded | number | Count of prior open edges closed by supersession (0 when `supersede=false`) |

Every write stamps bi-temporal validity (`validFrom`/`validTo` + `recordedAt`/`invalidatedAt`).

## Side effects

Neo4j relationship created or updated. Audit trail in ClickHouse.

## Errors

None explicitly defined in the contract.
