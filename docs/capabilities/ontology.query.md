# ontology.query

Typed multi-hop traversal over the knowledge graph. The caller names a start node, the relationship type(s) to follow, a direction, and a depth; the handler walks the tenant-scoped graph and returns the reachable subgraph as nodes and edges. This governed shape is the supported agent traversal surface; callers cannot submit raw Cypher.

## Mode
**sync**

## Surfaces
- API: `POST /v1/ontology/query`
- MCP: `ontology.query`
- Agent: callable (no approval required, risk: low)
- CLI: `oxagen ontology query`

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startNodeId` | string | yes | `publicId` of the node to start the traversal from |
| `edgeTypes` | string[] | no | Relationship type(s) to follow; omit to follow every known type |
| `direction` | `"out" \| "in" \| "both"` | no | Direction to traverse (default `out`) |
| `maxDepth` | integer | no | Maximum hop distance, 1–5 (default 2) |
| `limit` | integer | no | Maximum reachable nodes to return, 1–500 (default 100) |
| `asOf` | string (ISO-8601) | no | **Valid time** — traverse only edges true in the world at this instant. Omit for now (currently-valid facts). |
| `asKnownAt` | string (ISO-8601) | no | **Transaction time** — traverse using only what was recorded/known by this instant. Omit for now (currently-known facts). |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `startNode` | object \| null | The start node, or `null` if it does not exist in this org + workspace |
| `nodes` | object[] | Reachable nodes including the start node (depth 0), deduplicated by `nodeId` |
| `nodes[].depth` | integer | Hop distance from the start node (0 = start node) |
| `edges` | object[] | Edges traversed between the returned nodes (`fromNodeId`, `toNodeId`, `edgeType`) |
| `edges[].validFrom` / `.validTo` | string \| null | **Valid time** of the edge — when the fact became / stopped being true in the world (`validTo` null ⇒ still true) |
| `edges[].recordedAt` / `.invalidatedAt` | string \| null | **Transaction time** — when the edge was recorded / retracted (`invalidatedAt` null ⇒ still known) |
| `truncated` | boolean | True when the result was capped by `limit` and more nodes were reachable |

## Example

**Request:**
```http
POST /v1/ontology/query
{ "startNodeId": "node_abc", "edgeTypes": ["DEPENDS_ON"], "direction": "out", "maxDepth": 3 }
```

**Response:**
```json
{
  "startNode": { "nodeId": "node_abc", "label": "Service", "displayName": "API", "description": null, "depth": 0 },
  "nodes": [
    { "nodeId": "node_abc", "label": "Service", "displayName": "API", "description": null, "depth": 0 },
    { "nodeId": "node_def", "label": "Service", "displayName": "Auth", "description": null, "depth": 1 }
  ],
  "edges": [{ "fromNodeId": "node_abc", "toNodeId": "node_def", "edgeType": "DEPENDS_ON" }],
  "truncated": false
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner, Member, or Viewer at workspace level.
- Read-only; no side effects.
- **Tenant isolation:** the start node, every reached node, and every relationship on each path are constrained to the same `orgId` **and** `workspaceId`. A same-`publicId` node in another workspace can never seed or extend a traversal.
- **No Cypher injection surface:** relationship types are validated against the fixed `GRAPH_EDGE_TYPES` allow-list before they are composed into the variable-length pattern; depth is a validated integer in `[1,5]`.
- One extra row beyond `limit` is fetched to flag `truncated` honestly.

## Related
- `ontology.neighbors` — one-hop neighborhood of a node
- `graph.node.search` — text search over nodes
- `graph.search` — semantic search over eligible shared context
- [The ontology read set](_ontology-read-set.md) — the graph reads an agent is granted together, and the `toolPolicy.ontology` opt-in
