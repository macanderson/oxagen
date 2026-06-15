# graph.node.search

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low

## Intent

Fuzzy search KnowledgeNodes by text match on displayName and description,
optionally filtered by label.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| query | string | Text to search for in displayName or description (1-500 chars) |
| labels | array of strings? | Restrict results to nodes with one of these labels (optional) |
| limit | number | Maximum results to return: 1-50 (default: 10) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| nodes | array of objects | Matched nodes ranked by relevance |

Each node object:
- nodeId: string (publicId)
- label: string
- displayName: string
- description: string? (nullable)
- score: number (relevance: 1.0 for displayName match, 0.5 for description)

## Side effects

Read-only. Neo4j full-text search.

## Errors

None explicitly defined in the contract.
