# graph.node.list

Paginated browse of all nodes in the workspace graph. Enables the graph explorer UI.

## Mode
**sync**

## Surfaces
- API: `GET /v1/graph/nodes`
- MCP: `graph.node.list`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `labels` | string[] | no | Filter by node labels (e.g., `Feature`, `Issue`) |
| `sourceId` | string | no | Filter by source connector ID |
| `limit` | integer (1–250) | no | Max results per page; default 50 |
| `offset` | integer | no | Pagination offset; default 0 |
| `query` | string | no | Text search in `displayName` and `description` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `nodes` | object[] | Array of graph node records |
| `nodes[].id` | string | Node ID (Neo4j UUID) |
| `nodes[].labels` | string[] | Node labels |
| `nodes[].properties` | Record\<string, unknown\> | Node properties |
| `nodes[].displayName` | string | Human-readable node name |
| `nodes[].sourceId` | string \| undefined | Source connector ID |
| `nodes[].createdAt` | string \| undefined | ISO-8601 creation timestamp |
| `total` | number | Total nodes matching the filter |
| `hasMore` | boolean | Whether more nodes exist beyond this page |
| `limit` | number | Page size used |
| `offset` | number | Page offset used |

## Example

**Request:**
```http
GET /v1/graph/nodes?labels=Issue&query=auth&limit=5
```

**Response:**
```json
{
  "nodes": [
    {
      "id": "neo4j-uuid-abc",
      "labels": ["Issue", "KnowledgeNode"],
      "properties": {
        "title": "Fix OAuth token refresh",
        "status": "In Progress",
        "priority": "high"
      },
      "displayName": "Fix OAuth token refresh",
      "sourceId": "intg_jira_abc",
      "createdAt": "2026-05-10T08:00:00Z"
    }
  ],
  "total": 1,
  "hasMore": false,
  "limit": 5,
  "offset": 0
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- `query` performs text search over `displayName` and `description` properties using Neo4j full-text index.
- `labels` supports multiple values (all must match, AND semantics).
- For detailed node lookup by ID, use `graph.node.get`.

## Related
- `graph.node.get` — retrieve a single node by external ID
- `graph.node.search` — vector + full-text search
- `graph.stats` — aggregate node and edge counts
