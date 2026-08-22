# graph.node.get

Retrieve a single `KnowledgeNode` from the workspace graph by its `publicId`.

## Mode
**sync**

## Surfaces
- API: `GET /v1/graph/nodes/:nodeId`
- MCP: `graph.node.get`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nodeId` | string | yes | `publicId` of the `KnowledgeNode` to retrieve |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `node` | object \| null | The node, or `null` if no node with that `publicId` exists in this org + workspace |
| `node.nodeId` | string | `publicId` of the node |
| `node.label` | string | Domain label (e.g. `Issue`, `Topic`) |
| `node.displayName` | string | Human-readable node name |
| `node.description` | string \| null | Optional description |
| `node.properties` | Record\<string, unknown\> \| null | Decoded JSON property bag |
| `node.createdAt` | string | ISO-8601 creation timestamp |
| `node.updatedAt` | string \| null | ISO-8601 last-update timestamp |

## Example

**Request:**
```http
GET /v1/graph/nodes/node_abc
```

**Response:**
```json
{
  "node": {
    "nodeId": "node_abc",
    "label": "Issue",
    "displayName": "Fix OAuth token refresh",
    "description": "Token refresh fails after 1h",
    "properties": { "status": "open", "priority": "high" },
    "createdAt": "2026-05-10T08:00:00Z",
    "updatedAt": "2026-05-11T09:30:00Z"
  }
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner, Member, or Viewer at workspace level.
- Read-only; no side effects.
- **Tenant isolation:** the lookup is scoped by **both** `orgId` **and** `workspaceId`. A node with the same `publicId` in a different workspace of the same org is never returned.
- Returns `{ "node": null }` for a miss — not a 404 — so callers can distinguish "absent" from an error.

## Related
- `graph.node.list` — paginated browse of nodes
- `graph.node.search` — text search over nodes
- `ontology.neighbors` — retrieve the node's governed one-hop neighborhood
