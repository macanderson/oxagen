# semantic.relationship.approve

> **Replaces `semantic.edge.approve`** — `semantic.edge.approve` is a one-release alias that will be removed in v2. Migrate to `semantic.relationship.approve`. The capability name is the only change; input, output, and API path are identical.

Approve or reject an inferred semantic relationship candidate. Approved relationships are materialised as permanent `:SEMANTIC_EDGE` relationships in Neo4j; rejected relationships are soft-dismissed with an audit trail.

## Mode
**sync**

## Surfaces
- API: `POST /v1/semantic-relationships/{edgeId}/approve`
- MCP: `semantic.relationship.approve`
- Agent: callable (requires approval, risk: medium)
- CLI: not available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `edgeId` | string | yes | UUID of the inferred relationship to act on |
| `decision` | `approve` \| `reject` | yes | Materialise (`approve`) or soft-dismiss (`reject`) the relationship |
| `comment` | string (max 1000 chars) | no | Optional reviewer note for the audit trail |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `edgeId` | string | The inferred relationship ID that was acted on |
| `decision` | `approve` \| `reject` | Decision from input |
| `permanentEdgeId` | string \| undefined | Neo4j relationship element ID (present only when `decision="approve"`) |

## Example

**Request:**
```http
POST /v1/semantic-relationships/edge_abc123/approve
Content-Type: application/json

{
  "decision": "approve",
  "comment": "Confirmed — this PR implements the referenced Jira ticket"
}
```

**Response:**
```json
{
  "edgeId": "edge_abc123",
  "decision": "approve",
  "permanentEdgeId": "neo4j_rel_5678"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Sensitivity: medium — approved relationships become permanent graph data.
- **Agent requires approval** before executing this action.
- Approved relationships are written as permanent `:SEMANTIC_EDGE` nodes in Neo4j and no longer appear in `semantic.relationship.suggest`.
- Rejected relationships are soft-dismissed with an audit trail; they remain queryable via `semantic.relationship.list` but are excluded from future suggest results.

## Related
- `semantic.edge.approve` — deprecated alias; removed in v2
- `semantic.relationship.list` — browse all inferred relationships
- `semantic.relationship.suggest` — browse unapproved candidates
- `semantic.relationship.infer` — trigger inference to generate new candidates
