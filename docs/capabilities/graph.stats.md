# graph.stats

Workspace graph statistics: node count, edge count, inferred edge count, and breakdown by type.

## Mode
**sync**

## Surfaces
- API: `GET /v1/graph/stats`
- MCP: `graph.stats`
- Agent: callable (no approval required, risk: low)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeByType` | boolean | no | Include breakdown by node label and edge type; default `false` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `nodeCount` | number | Total number of nodes in the graph |
| `edgeCount` | number | Total number of edges (all types) |
| `inferredEdgeCount` | number | Number of edges created by LLM inference |
| `sourceCount` | number | Number of unique source connectors |
| `nodesByLabel` | Record\<string, number\> \| undefined | Node count breakdown by label (present when `includeByType=true`) |
| `edgesByType` | Record\<string, number\> \| undefined | Edge count breakdown by type (present when `includeByType=true`) |
| `lastModifiedAt` | string | ISO-8601 timestamp of last graph modification |

## Example

**Request:**
```http
GET /v1/graph/stats?includeByType=true
```

**Response:**
```json
{
  "nodeCount": 6200,
  "edgeCount": 18450,
  "inferredEdgeCount": 3210,
  "sourceCount": 4,
  "nodesByLabel": {
    "Issue": 1650,
    "PullRequest": 890,
    "Commit": 3088,
    "Feature": 572
  },
  "edgesByType": {
    "IMPLEMENTS": 412,
    "RELATED_TO": 1875,
    "BLOCKS": 233,
    "AUTHORED_BY": 3088
  },
  "lastModifiedAt": "2026-06-10T14:05:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- Statistics are computed in real time from Neo4j; on very large graphs this call may take a few seconds.
- `inferredEdgeCount` counts edges from `semantic.edge.infer` only; manually-created edges via `graph.edge.upsert` are counted in `edgeCount` but not `inferredEdgeCount`.

## Related
- `graph.node.list` — browse individual nodes
- `graph.node.search` — search nodes by text or vector
- `semantic.edge.list` — browse inferred semantic edges
- `integration.metrics` — per-integration entity counts
