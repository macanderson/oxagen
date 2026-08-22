# graph.node.search

Text search over the workspace graph. Matches `displayName` and `description`, with optional label filtering, returning the best-ranked nodes.

## Mode
**sync**

## Surfaces
- API: `GET /v1/graph/nodes/search`
- MCP: `graph.node.search`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Case-insensitive substring matched against `displayName` and `description` |
| `labels` | string[] | no | Restrict results to these node labels |
| `limit` | integer | yes | Max results to return |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `nodes` | object[] | Ranked matches |
| `nodes[].nodeId` | string | `publicId` of the node |
| `nodes[].label` | string | Domain label |
| `nodes[].displayName` | string | Human-readable node name |
| `nodes[].description` | string \| null | Optional description |
| `nodes[].score` | number | Relevance score (`displayName` hit ranks above a `description`-only hit) |

## Example

**Request:**
```http
GET /v1/graph/nodes/search?query=oauth&labels=Issue&limit=5
```

**Response:**
```json
{
  "nodes": [
    {
      "nodeId": "node_abc",
      "label": "Issue",
      "displayName": "Fix OAuth token refresh",
      "description": "Token refresh fails after 1h",
      "score": 1.0
    }
  ]
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- **Tenant isolation:** results are scoped by **both** `orgId` **and** `workspaceId`.
- Ranking is deterministic and index-free: a `displayName` match scores `1.0`, a `description`-only match `0.5`, and a match on both `0.75`. Results are ordered by score, then `displayName`.
- The optional `labels` filter is appended only when supplied — there is no dynamic Cypher.

## Related
- `graph.node.list` — paginated browse with filters
- `graph.node.get` — retrieve a single node by `publicId`
- `graph.stats` — aggregate node and edge counts
