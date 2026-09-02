# ontology.neighbors

The one-hop neighborhood of a node — a focused, cheap traversal primitive (depth 1) for "what is directly connected to X?" without the caller writing Cypher. Org + workspace scoped, read-only. Pairs with `ontology.query` for deeper multi-hop walks.

## Mode
**sync**

## Surfaces
- API: `POST /v1/ontology/neighbors`
- MCP: `ontology.neighbors`
- Agent: callable (no approval required, risk: low)
- CLI: `oxagen ontology neighbors`

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `nodeId` | string | yes | `publicId` of the node whose neighbors to fetch |
| `edgeTypes` | string[] | no | Relationship type(s) to include; omit to include all types |
| `direction` | `"out" \| "in" \| "both"` | no | Which neighbors to return relative to the node (default `both`) |
| `limit` | integer | no | Maximum neighbors to return, 1–500 (default 100) |
| `asOf` | string (ISO-8601) | no | **Valid time** — include only edges true in the world at this instant. Omit for now. |
| `asKnownAt` | string (ISO-8601) | no | **Transaction time** — include only edges recorded/known by this instant. Omit for now. |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `nodeId` | string | `publicId` echoed back from the request |
| `found` | boolean | True if the node exists in this org + workspace |
| `neighbors` | object[] | Directly connected nodes |
| `neighbors[].edgeType` | string | Relationship type connecting the node to this neighbor |
| `neighbors[].direction` | `"out" \| "in"` | `out` if the edge points from the node to the neighbor; `in` otherwise |
| `neighbors[].isSystem` | boolean | True when the neighbor is product-owned runtime lineage (executions, agents, tools, generated files) rather than customer knowledge — lets callers separate the source-system ontology from agent activity |
| `neighbors[].validFrom` / `.validTo` | string \| null | **Valid time** of the connecting edge (`validTo` null ⇒ still true) |
| `neighbors[].recordedAt` / `.invalidatedAt` | string \| null | **Transaction time** of the connecting edge (`invalidatedAt` null ⇒ still known) |
| `truncated` | boolean | True when the result was capped by `limit` and more neighbors exist |

## Example

**Request:**
```http
POST /v1/ontology/neighbors
{ "nodeId": "node_abc", "edgeTypes": ["RELATED_TO"], "direction": "both" }
```

**Response:**
```json
{
  "nodeId": "node_abc",
  "found": true,
  "neighbors": [
    { "nodeId": "node_def", "label": "Topic", "displayName": "Auth", "description": null, "edgeType": "RELATED_TO", "direction": "out", "isSystem": false }
  ],
  "truncated": false
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner, Member, or Viewer at workspace level.
- Read-only; no side effects.
- **Tenant isolation:** the anchor node and every neighbor are constrained to the same `orgId` **and** `workspaceId`. A missing node (or one in another workspace) reports `found: false` with no neighbors.
- **No Cypher injection surface:** relationship types are validated against the fixed `GRAPH_EDGE_TYPES` allow-list and passed as a bound parameter; the direction filter is a static clause chosen from a closed set.

## Related
- `ontology.query` — typed multi-hop traversal
- `graph.node.get` — retrieve a single node by `publicId`
- [The ontology read set](_ontology-read-set.md) — the graph reads an agent is granted together, and the `toolPolicy.ontology` opt-in
