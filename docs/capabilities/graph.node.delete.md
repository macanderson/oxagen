# graph.node.delete

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** high

## Intent

Delete a KnowledgeNode and all its relationships from the graph.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| nodeId | string | publicId of the KnowledgeNode to delete |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| deleted | boolean | True if found and deleted; false if did not exist |

## Side effects

Neo4j node and all attached relationships deleted. Audit trail in ClickHouse.

## Errors

None explicitly defined in the contract.
