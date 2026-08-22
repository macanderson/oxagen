# graph.search

Natural-language semantic search across eligible shared workspace knowledge — customer entities, provider metadata, agent memories, execution metadata, documents, messages, and generated assets — ranked by vector similarity.

This is a search over governed central context, not a remote code index. Repository source text, symbols, chunks, code embeddings, imports, and uncommitted checkout state remain in the local code graph and are never returned by this capability.

Distinct from `graph.node.search`, which performs lexical substring matching on `displayName` and `description`.

## Mode
**sync**

## Surfaces
- API: `POST /v1/{org}/{workspace}/graph/search`
- MCP: `graph.search`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Natural-language query to embed and search by cosine similarity |
| `limit` | integer | no | Max results (1–50, default 10) |
| `kinds` | string[] | no | Filter by node kind: `entity`, `memory`, `execution`, `document`, `message`, `asset` |
| `isSystem` | boolean | no | `true` = product-owned nodes only; `false` = customer nodes only; omit for all |
| `labels` | string[] | no | Domain-label filter (e.g. `["Person", "Repository", "PullRequest"]`) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `results` | object[] | Results ranked by cosine similarity score |
| `results[].nodeId` | string | `publicId` of the matching node |
| `results[].label` | string | Domain label (e.g. `Person`, `Repository`, `PullRequest`) |
| `results[].displayName` | string | Human-readable name |
| `results[].kind` | string | Derived shared-context kind (`entity`, `memory`, `execution`, `document`, `message`, or `asset`) |
| `results[].snippet` | string | Short eligible-content snippet (max 240 chars) or display name |
| `results[].score` | number | Cosine similarity score from the vector index |
| `results[].isSystem` | boolean | Whether this is a product-owned node |

## Example

**Request:**
```http
POST /v1/acme/main/graph/search
Content-Type: application/json

{
  "query": "which pull request changed the authentication flow",
  "limit": 5,
  "labels": ["PullRequest", "Commit"]
}
```

**Response:**
```json
{
  "results": [
    {
      "nodeId": "node_abc",
      "label": "PullRequest",
      "displayName": "Harden authentication token refresh",
      "kind": "entity",
      "snippet": "Harden authentication token refresh",
      "score": 0.94,
      "isSystem": false
    }
  ]
}
```

## Notes
- **Eligibility:** only graph records admitted by governed ingestion or an explicit approval flow are searchable. Local code-graph records are excluded.
- **Vector index:** the query runs against embeddings for eligible shared knowledge. It does not create or search source-code embeddings.
- **Access:** Owner or Admin at org level; Owner, Member, or Viewer at workspace level. Read-only; no side effects.
- **Tenant isolation:** results are always scoped by **both** `orgId` **and** `workspaceId`.
- **Provider metadata:** repository, ref, commit, pull-request, workflow-run, and changed-file facts use their domain labels and normally derive to `entity`.
- **Follow-ups:** canonical topology from configured protected/default refs and typed execution evidence are not implied by a semantic-search result.

## Related
- `graph.node.search` — lexical substring search on displayName and description
- `graph.node.list` — paginated browse with filters
- `graph.stats` — aggregate node and edge counts
