# graph.search

Natural-language semantic (vector) search across the entire knowledge graph — customer entities, source code files, symbols, code chunks, agent memories, executions, documents, and messages — ranked by embedding similarity using the universal `graph_node_embedding_index`.

Distinct from `graph.node.search`, which performs lexical substring matching on `displayName` and `description`.

## Mode
**sync**

## Surfaces
- API: `POST /v1/{org}/{workspace}/graph/search`
- MCP: `graph.search`
- Agent: callable (no approval required, risk: low)
- CLI: `oxagen graph search`

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural-language query to embed and search by cosine similarity |
| `limit` | integer | no | Max results (1–50, default 10) |
| `kinds` | string[] | no | Filter by node kind: `entity`, `file`, `symbol`, `chunk`, `memory`, `execution`, `document`, `message` |
| `isSystem` | boolean | no | `true` = product-owned nodes only; `false` = customer nodes only; omit for all |
| `labels` | string[] | no | Domain-label filter (e.g. `["Person", "SourceFile"]`) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `results` | object[] | Results ranked by cosine similarity score |
| `results[].nodeId` | string | `publicId` of the matching node |
| `results[].label` | string | Domain label (e.g. `SourceFile`, `Person`) |
| `results[].displayName` | string | Human-readable name |
| `results[].kind` | string | Derived kind (`entity`, `file`, `symbol`, etc.) |
| `results[].snippet` | string | Content snippet (from `properties.content`, max 240 chars) or displayName |
| `results[].score` | number | Cosine similarity score from the vector index |
| `results[].isSystem` | boolean | Whether this is a product-owned node |

## Example

**Request:**
```http
POST /v1/acme/main/graph/search
Content-Type: application/json

{
  "query": "authentication token refresh",
  "limit": 5,
  "kinds": ["file", "symbol"]
}
```

**Response:**
```json
{
  "results": [
    {
      "nodeId": "node_abc",
      "label": "SourceFile",
      "displayName": "auth/token.ts",
      "kind": "file",
      "snippet": "auth/token.ts",
      "score": 0.94,
      "isSystem": true
    }
  ]
}
```

## Notes
- **Vector index:** uses the universal `graph_node_embedding_index FOR (n:GraphNode) ON (n.embedding)` (cosine, 1536 dims).
- **Embedding model:** `openai/text-embedding-3-small` via Vercel AI Gateway (pinned; same model used by `graph.node.upsert` and ingestion).
- **Access:** Owner or Admin at org level; Owner, Member, or Viewer at workspace level. Read-only; no side effects.
- **Tenant isolation:** results are always scoped by **both** `orgId` **and** `workspaceId`.
- **Kind derivation:** derived from Neo4j labels at query time (`SourceFile`→`file`, `SourceSymbol`→`symbol`, `SourceChunk`→`chunk`, `Execution`→`execution`, `AgentMemory`→`memory`, `Document`→`document`, `Message`→`message`, else `entity`).
- **Nodes are embedded on upsert:** `graph.node.upsert` embeds the node text immediately after MERGE (best-effort, non-blocking). Nodes created before this change may not have embeddings yet.

## Related
- `graph.node.search` — lexical substring search on displayName and description
- `graph.node.upsert` — create or update a node (also embeds it for semantic search)
- `graph.node.list` — paginated browse with filters
- `graph.stats` — aggregate node and edge counts
