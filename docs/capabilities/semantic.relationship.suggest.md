# semantic.relationship.suggest

> **Replaces `semantic.edge.suggest`** — `semantic.edge.suggest` is a one-release alias that will be removed in v2. Migrate to `semantic.relationship.suggest`. The capability name is the only change; input, output, and behavior are identical.

Returns inferred semantic relationships pending human review (below the auto-accept confidence threshold). Intended for the approval flow UI — relationships returned here are read-only candidates until a workspace member approves or dismisses them via `semantic.relationship.approve`.

## Mode
**sync**

## Surfaces
- API: `GET /v1/semantic-relationships/suggest`
- MCP: `semantic.relationship.suggest`
- Agent: callable (no approval required, risk: low)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confidenceMin` | number (0.0–1.0) | no | Lower bound on confidence (inclusive); use to skip very low-confidence noise |
| `confidenceMax` | number (0.0–1.0) | no | Upper bound on confidence (inclusive); typically set to the workspace auto-accept threshold |
| `limit` | integer (1–250) | no | Maximum suggestions to return; default 50 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `suggestions` | object[] | Unapproved relationship candidates sorted by confidence descending |
| `suggestions[].id` | string | Unique relationship identifier |
| `suggestions[].sourceNodeId` | string | `publicId` of the source KnowledgeNode |
| `suggestions[].targetNodeId` | string | `publicId` of the target KnowledgeNode |
| `suggestions[].type` | string | Relationship type as inferred by the LLM |
| `suggestions[].confidence` | number | Inference confidence score (0.0–1.0) |
| `suggestions[].source.connectorId` | string | Connector that owns the source node |
| `suggestions[].inferredAt` | string | ISO-8601 timestamp when the relationship was inferred |
| `total` | number | Total unapproved relationships matching the confidence filter |
| `limit` | number | Page size used |

## Example

**Request:**
```http
GET /v1/semantic-relationships/suggest?confidenceMin=0.5&confidenceMax=0.8&limit=20
```

**Response:**
```json
{
  "suggestions": [
    {
      "id": "edge_def456",
      "sourceNodeId": "kn_issue_3001",
      "targetNodeId": "kn_pr_2002",
      "type": "RELATED_TO",
      "confidence": 0.72,
      "source": {
        "connectorId": "intg_jira_abc",
        "sourceId": "PLAT-301"
      },
      "inferredAt": "2026-06-10T10:00:00Z"
    }
  ],
  "total": 1,
  "limit": 20
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Sensitivity: high — exposes relationships between cross-source entities.
- Returns only relationships where `approved` is `false`. Already-approved or rejected relationships are excluded.
- Results are sorted by confidence descending so the most confident suggestions appear first.
- This endpoint is read-only — approving or dismissing suggestions requires a separate call to `semantic.relationship.approve`.

## Related
- `semantic.edge.suggest` — deprecated alias; removed in v2
- `semantic.relationship.infer` — trigger inference to generate new suggestions
- `semantic.relationship.list` — browse all relationships including approved ones
- `semantic.relationship.approve` — approve or reject a suggestion
