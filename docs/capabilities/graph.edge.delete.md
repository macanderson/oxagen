# graph.edge.delete

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** medium

## Intent

Delete a specific typed relationship between two KnowledgeNodes.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fromNodeId | string | publicId of the source KnowledgeNode |
| toNodeId | string | publicId of the target KnowledgeNode |
| edgeType | enum | Type of relationship: RELATED_TO, PART_OF, CAUSED_BY, REFERENCES, SIMILAR_TO, DEPENDS_ON, CREATED_BY, MENTIONS |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| deleted | boolean | True if found and deleted; false if did not exist |

## Side effects

Neo4j relationship deleted (if it exists). Audit trail in ClickHouse.

## Errors

None explicitly defined in the contract.
