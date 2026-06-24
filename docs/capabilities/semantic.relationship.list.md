# semantic.relationship.list

> **Replaces `semantic.edge.list`** — `semantic.edge.list` is a one-release alias that will be removed in v2. Migrate to `semantic.relationship.list`. The capability name is the only change; input, output, and API path are identical.

Paginated browse of inferred semantic relationships for a workspace. Supports filtering by relationship type, connector source, and confidence band.

## Mode
**sync**

## Surfaces
- API: `GET /v1/semantic-relationships`
- MCP: `semantic.relationship.list`
- Agent: callable (no approval required, risk: low)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | no | Filter to relationships of this type |
| `sourceId` | string | no | Filter to relationships whose source node originates from this connector source ID |
| `confidenceMin` | number (0.0–1.0) | no | Return only relationships with confidence >= this value |
| `confidenceMax` | number (0.0–1.0) | no | Return only relationships with confidence <= this value |
| `limit` | integer (1–250) | no | Results per page; default 50 |
| `offset` | integer | no | Zero-based page offset; default 0 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `edges` | object[] | Array of semantic relationship records |
| `edges[].id` | string | Unique relationship identifier |
| `edges[].sourceNodeId` | string | `publicId` of the source KnowledgeNode |
| `edges[].targetNodeId` | string | `publicId` of the target KnowledgeNode |
| `edges[].type` | string | Relationship type as inferred by the LLM |
| `edges[].confidence` | number | Inference confidence score (0.0–1.0) |
| `edges[].source.connectorId` | string | Connector that owns the source node |
| `edges[].source.sourceId` | string | Connector-internal source identifier |
| `edges[].inferredAt` | string | ISO-8601 timestamp when the relationship was inferred |
| `edges[].approved` | boolean \| undefined | Whether the relationship has been approved |
| `edges[].approvedAt` | string \| null \| undefined | ISO-8601 approval timestamp |
| `edges[].approvedBy` | string \| null \| undefined | User ID who approved the relationship |
| `total` | number | Total relationships matching the filter (before pagination) |
| `limit` | number | Page size used |
| `offset` | number | Page offset used |

## Example

**Request:**
```http
GET /v1/semantic-relationships?type=IMPLEMENTS&confidenceMin=0.8&limit=10
```

**Response:**
```json
{
  "edges": [
    {
      "id": "edge_abc123",
      "sourceNodeId": "kn_pr_1001",
      "targetNodeId": "kn_issue_2045",
      "type": "IMPLEMENTS",
      "confidence": 0.94,
      "source": {
        "connectorId": "intg_github_xyz",
        "sourceId": "PR#1001"
      },
      "inferredAt": "2026-06-10T10:00:00Z",
      "approved": true,
      "approvedAt": "2026-06-10T11:00:00Z",
      "approvedBy": "user_mac"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Sensitivity: high — exposes relationships between entities from potentially different data sources.
- Returns both approved and unapproved relationships. Use `semantic.relationship.suggest` to query only unapproved candidates.
- Relationship `type` values are free-form strings defined by the inference prompt, not a fixed enum.

## Related
- `semantic.edge.list` — deprecated alias; removed in v2
- `semantic.relationship.infer` — trigger LLM inference to create new relationships
- `semantic.relationship.suggest` — browse only unapproved candidate relationships
- `graph.node.list` — browse nodes that relationships connect
