# graph.node.delete

Delete a `KnowledgeNode` and all of its relationships from the workspace graph.

## Mode
**sync**

## Surfaces
- API: `DELETE /v1/graph/nodes/:nodeId`
- MCP: `graph.node.delete`
- Agent: callable (approval required, risk: medium)
- CLI: `oxagen graph node delete`

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nodeId` | string | yes | `publicId` of the `KnowledgeNode` to delete |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `deleted` | boolean | `true` if a node was found and deleted; `false` if no matching node existed |

## Example

**Request:**
```http
DELETE /v1/graph/nodes/node_abc
```

**Response:**
```json
{ "deleted": true }
```

## Notes
- **Access:** Owner or Admin at org level; Owner only at workspace level.
- **Destructive.** Uses `DETACH DELETE`, so the node and every relationship attached to it are removed atomically.
- **Tenant isolation:** the delete is scoped by **both** `orgId` **and** `workspaceId`. A same-`publicId` node in another workspace of the same org can never be deleted through this call.
- **Telemetry:** every invocation emits a `tool_invocations` row to ClickHouse via the shared `@oxagen/telemetry` seam (`risk_level: high`), fire-and-forget so the response is never delayed. `status` is `completed` when a node was deleted, `failed` when none matched.

## Related
- `graph.node.get` — retrieve a node by `publicId`
- `graph.edge.delete` — delete a single relationship
- `graph.node.upsert` — create or update a node
