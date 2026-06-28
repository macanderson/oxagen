# graph.export

Paginated, cursor-aware read of a workspace subgraph (nodes + edges) for downloading into a local projection (e.g. the CLI's DuckDB read-replica). Unlike `graph.node.list` (UI browse), this capability is built for *sync*: it returns edges alongside nodes, keys everything by the stable `publicId` so a local copy can be reconciled deterministically, and supports incremental refresh via `updatedAfter` + a returned `cursor` (the max `updatedAt` in the page). See ADR-018.

## Mode
**sync**

## Surfaces
- API: `POST /v1/graph/export`
- MCP: `graph.export`
- Agent: callable (no approval required, risk: low)
- CLI: `oxagen graph pull` (uses this capability)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `labels` | string[] | no | Restrict to these node labels (e.g. `Feature`, `Issue`). Omit for all. |
| `isSystem` | boolean | no | `false` = customer ontology only; `true` = product-owned (code/execution/memory) only; omit for both. |
| `updatedAfter` | string (ISO-8601) | no | High-watermark for incremental pull — returns only nodes updated strictly after this timestamp. |
| `includeEdges` | boolean | no | Include edges between returned nodes (default `true`). Set `false` for a nodes-only page. |
| `limit` | integer (1–1000) | no | Max nodes per page; default 500. |
| `offset` | integer | no | Pagination offset; default 0. Prefer `cursor` for incremental pulls. |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `nodes` | object[] | Array of node records for the page |
| `nodes[].id` | string | Stable `publicId` — the local copy's primary key |
| `nodes[].labels` | string[] | Node labels (e.g. `["KnowledgeNode", "Issue"]`) |
| `nodes[].displayName` | string | Human-readable node name |
| `nodes[].properties` | Record\<string, unknown\> | Full property bag |
| `nodes[].sourceId` | string \| undefined | Source connector id, if any |
| `nodes[].isSystem` | boolean | `true` for product-owned nodes (code, execution, memory) |
| `nodes[].updatedAt` | string \| undefined | ISO-8601 last-update timestamp |
| `edges` | object[] | Edges between nodes in this page (empty when `includeEdges=false`) |
| `edges[].id` | string | Stable edge id |
| `edges[].sourceId` | string | `publicId` of the source node |
| `edges[].targetId` | string | `publicId` of the target node |
| `edges[].type` | string | Relationship type (e.g. `RELATES_TO`, `DEPENDS_ON`) |
| `edges[].properties` | Record\<string, unknown\> | Edge property bag |
| `edges[].inferred` | boolean | `true` for semantically-inferred edges |
| `total` | number | Total nodes matching the filter (for progress reporting) |
| `hasMore` | boolean | Whether more nodes exist beyond this page |
| `limit` | number | Page size used |
| `offset` | number | Page offset used |
| `cursor` | string \| null | Max `updatedAt` in this page — pass as `updatedAfter` to continue incrementally |

## Example

**Request:**
```http
POST /v1/graph/export
Content-Type: application/json

{
  "labels": ["Feature"],
  "updatedAfter": "2026-06-01T00:00:00Z",
  "includeEdges": true,
  "limit": 100,
  "offset": 0
}
```

**Response:**
```json
{
  "nodes": [
    {
      "id": "pub_abc123",
      "labels": ["KnowledgeNode", "Feature"],
      "displayName": "Dark mode support",
      "properties": { "status": "In Progress", "priority": "high" },
      "sourceId": "intg_linear_abc",
      "isSystem": false,
      "updatedAt": "2026-06-15T08:30:00Z"
    }
  ],
  "edges": [
    {
      "id": "edge_xyz",
      "sourceId": "pub_abc123",
      "targetId": "pub_def456",
      "type": "DEPENDS_ON",
      "properties": {},
      "inferred": false
    }
  ],
  "total": 1,
  "hasMore": false,
  "limit": 100,
  "offset": 0,
  "cursor": "2026-06-15T08:30:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- **Incremental sync:** Pass the returned `cursor` as `updatedAfter` on subsequent calls. The cursor is the max `updatedAt` in the current page; nodes without an `updatedAt` property do not advance the cursor.
- **Edges are restricted to the current node page.** An edge is returned only if its source node's `publicId` is in the current page. This keeps the response consistent and avoids returning edges for nodes outside the pagination window.
- **Tenant isolation:** Both node queries and the edge query are scoped by `orgId` and `workspaceId`. Cross-workspace leakage is impossible even when two workspaces in the same org share a node `publicId`.
- `labels` filters by the stored `label` property, not by Neo4j label. Omit for a full-graph export.
- `isSystem=false` returns only customer ontology nodes. `isSystem=true` returns product-owned artifacts (ingested code, agent executions, memories).

## Related
- `graph.node.list` — UI browse with text search; smaller pages, no edges
- `graph.node.get` — retrieve a single node by publicId
- `graph.node.search` — vector + full-text search
- `graph.stats` — aggregate node and edge counts
- `semantic.edge.list` — browse inferred semantic edges
