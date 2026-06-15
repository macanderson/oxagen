# graph.node.get

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low

## Intent

Retrieve a KnowledgeNode by its publicId.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| nodeId | string | publicId of the KnowledgeNode to retrieve |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| node | object? | The node object or null if not found |

Node object structure:
- nodeId: string (publicId)
- label: string (node type)
- displayName: string
- description: string? (nullable)
- properties: object? (arbitrary metadata, nullable)
- createdAt: string
- updatedAt: string? (nullable)

## Side effects

Read-only. Neo4j lookup.

## Errors

None explicitly defined in the contract.
