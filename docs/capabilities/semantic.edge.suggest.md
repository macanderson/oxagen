# semantic.edge.suggest

> **Deprecated** — `semantic.edge.suggest` is a one-release alias for [`semantic.relationship.suggest`](semantic.relationship.suggest.md), which will be the canonical name from v2 onward. Migrate now: the capability name is the only change; input, output, and API path are identical.

Returns inferred semantic edges that are pending human review (below the auto-accept confidence threshold). Intended for the approval flow UI — edges returned here are read-only candidates until a workspace member approves or dismisses them.

## Mode
**sync**

## Surfaces
- API: `GET /v1/semantic-edges/suggest`
- MCP: `semantic.edge.suggest`
- Agent: callable (no approval required, risk: low)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confidenceMin` | number (0.0–1.0) | no | Lower bound on confidence (inclusive). Use to skip very low-confidence noise. |
| `confidenceMax` | number (0.0–1.0) | no | Upper bound on confidence (inclusive). Typically set to the workspace auto-accept threshold. |
| `limit` | integer (1–250) | no | Maximum suggestions to return; default 50 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `suggestions` | object[] | Unapproved edge candidates sorted by confidence descending |
| `suggestions[].id` | string | Unique edge identifier |
| `suggestions[].sourceNodeId` | string | `publicId` of the source KnowledgeNode |
| `suggestions[].targetNodeId` | string | `publicId` of the target KnowledgeNode |
| `suggestions[].type` | string | Relationship type as inferred by the LLM |
| `suggestions[].confidence` | number | Inference confidence score (0.0–1.0) |
| `suggestions[].source.connectorId` | string | Connector that owns the source node |
| `suggestions[].inferredAt` | string | ISO-8601 timestamp when the edge was inferred |
| `total` | number | Total unapproved edges matching the confidence filter |
| `limit` | number | Page size used |

## Example

**Request:**
```http
GET /v1/semantic-edges/suggest?confidenceMin=0.5&confidenceMax=0.8&limit=20
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
      "inferredAt": "2026-06-10T10:00:00Z",
      "approved": false,
      "approvedAt": null,
      "approvedBy": null
    }
  ],
  "total": 1,
  "limit": 20
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Sensitivity: high — exposes relationships between cross-source entities.
- Returns only edges where `approved` is `false`. Already-approved edges are excluded.
- Results are sorted by confidence descending so the most confident suggestions appear first.
- This endpoint is designed for the human approval UI; it does not modify any data. Approving or dismissing suggestions requires a separate action.

## Related
- `semantic.edge.infer` — trigger inference to generate new suggestions
- `semantic.edge.list` — browse all edges including approved ones
- `graph.node.list` — fetch node details for the suggestion UI
