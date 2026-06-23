# graph.edge.upsert

> **Deprecated** — `graph.edge.upsert` is a one-release alias for [`graph.relationship.upsert`](graph.relationship.upsert.md), which will be the canonical name from v2 onward. Migrate now: rename `edgeType` → `relationshipType` (now open-vocabulary, not a fixed enum) and `edgeId` → `relationshipId` in the output.

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
| edgeType | enum | Relationship type: RELATED_TO, PART_OF, CAUSED_BY, REFERENCES, SIMILAR_TO, DEPENDS_ON, CREATED_BY, MENTIONS |
| properties | object? | Optional string key-value metadata for the relationship (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| edgeId | string | Composite identifier: fromNodeId:edgeType:toNodeId |
| created | boolean | True if newly created; false if already existed |

## Side effects

Neo4j relationship created or updated. Audit trail in ClickHouse.

## Errors

None explicitly defined in the contract.
