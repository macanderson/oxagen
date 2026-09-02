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
| `includeGrowth` | boolean | no | Include node-creation time buckets (today/yesterday/this week/last week) and a 14-day daily series; default `false` |

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
| `growth` | object \| undefined | Node-creation time buckets (present only when `includeGrowth=true`) — see below |

### `growth` object (present only when `includeGrowth=true`)
| Field | Type | Description |
|-------|------|-------------|
| `nodesToday` | number | Nodes created since the start of today (UTC) |
| `nodesYesterday` | number | Nodes created during the prior UTC day |
| `nodesThisWeek` | number | Nodes created in the last 7 days (rolling, incl today) |
| `nodesLastWeek` | number | Nodes created in the 7 days before this week |
| `daily` | Array\<{ day: string; count: number }\> | Last 14 UTC days of node-creation counts, ascending, zero-filled. `day` is a `YYYY-MM-DD` UTC calendar day |

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

**Request (with growth):**
```http
GET /v1/graph/stats?includeGrowth=true
```

**Response (growth block only shown):**
```json
{
  "nodeCount": 6200,
  "edgeCount": 18450,
  "inferredEdgeCount": 3210,
  "sourceCount": 4,
  "lastModifiedAt": "2026-06-10T14:05:00Z",
  "growth": {
    "nodesToday": 42,
    "nodesYesterday": 31,
    "nodesThisWeek": 210,
    "nodesLastWeek": 175,
    "daily": [
      { "day": "2026-05-28", "count": 12 },
      { "day": "2026-05-29", "count": 0 },
      { "day": "2026-05-30", "count": 8 },
      { "day": "2026-05-31", "count": 15 },
      { "day": "2026-06-01", "count": 22 },
      { "day": "2026-06-02", "count": 19 },
      { "day": "2026-06-03", "count": 25 },
      { "day": "2026-06-04", "count": 30 },
      { "day": "2026-06-05", "count": 18 },
      { "day": "2026-06-06", "count": 27 },
      { "day": "2026-06-07", "count": 21 },
      { "day": "2026-06-08", "count": 29 },
      { "day": "2026-06-09", "count": 31 },
      { "day": "2026-06-10", "count": 42 }
    ]
  }
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- Statistics are computed in real time from Neo4j; on very large graphs this call may take a few seconds.
- `inferredEdgeCount` is a legacy provenance count for already-materialized relationships. No launch mutation or review surface creates new inferred edges.
- `growth` is opt-in via `includeGrowth=true` and is absent otherwise, so existing consumers (chat render, knowledge page) are unaffected. Buckets are computed from `GraphNode.createdAt` (a Neo4j temporal `datetime`) over **UTC** calendar days: `nodesThisWeek` is a rolling 7-day window including today, `nodesLastWeek` the 7 days before it, and `daily` is the last 14 UTC days ascending and zero-filled. Nodes missing `createdAt` are excluded.

## Related
- `graph.node.list` — browse individual nodes
- `graph.node.search` — search nodes by text or vector
- `integration.metrics` — per-integration entity counts
- [The ontology read set](_ontology-read-set.md) — the graph reads an agent is granted together, and the `toolPolicy.ontology` opt-in
