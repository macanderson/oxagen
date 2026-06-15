# graph.edge.delete

Delete a specific typed relationship between two `KnowledgeNode`s in the workspace graph.

## Mode
**sync**

## Surfaces
- API: `DELETE /v1/graph/edges`
- MCP: `graph.edge.delete`
- Agent: callable (approval required, risk: medium)
- CLI: `oxagen graph edge delete`

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromNodeId` | string | yes | `publicId` of the source node |
| `toNodeId` | string | yes | `publicId` of the target node |
| `edgeType` | enum | yes | Relationship type: one of `RELATED_TO`, `PART_OF`, `CAUSED_BY`, `REFERENCES`, `SIMILAR_TO`, `DEPENDS_ON`, `CREATED_BY`, `MENTIONS` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `deleted` | boolean | `true` if the relationship was found and deleted; `false` if it did not exist |

## Example

**Request:**
```http
DELETE /v1/graph/edges
Content-Type: application/json

{ "fromNodeId": "node_a", "toNodeId": "node_b", "edgeType": "DEPENDS_ON" }
```

**Response:**
```json
{ "deleted": true }
```

## Notes
- **Access:** Owner or Admin at org level; Owner only at workspace level.
- **Destructive.** Deletes only the named relationship; both endpoint nodes are left intact.
- **Tenant isolation:** both endpoint nodes are matched with `orgId` **and** `workspaceId`, so an edge between same-`publicId` nodes in another workspace of the same org can never be deleted.
- Each `edgeType` dispatches a static, parameterised Cypher query (one per relationship type) — never dynamic Cypher — keeping the query planner happy and eliminating injection surface.
- **Telemetry:** every invocation emits a `tool_invocations` row to ClickHouse via the shared `@oxagen/telemetry` seam (`risk_level: high`), fire-and-forget.

## Related
- `graph.edge.upsert` — create or update a relationship
- `graph.node.delete` — delete a node and all its relationships
- `graph.cypher` — read-only ad-hoc Cypher
