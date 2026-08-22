# schema.reconcile.status

Poll the status and progress of a schema reconciliation job dispatched by `schema.reconcile.dispatch`.

## Mode
**sync**

## Surfaces
- API: `GET /v1/schema/reconcile/{executionId}`
- MCP: `schema.reconcile.status`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `executionId` | string | yes | Agent execution ID returned by `schema.reconcile.dispatch` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `status` | `planning` \| `running` \| `completed` \| `failed` \| `cancelled` | Current job status |
| `totalNodes` | number | Total nodes to process |
| `processedNodes` | number | Nodes evaluated so far |
| `updatedNodes` | number | Nodes whose labels were changed |
| `totalRelationships` | number | Total relationships to process |
| `processedRelationships` | number | Relationships evaluated so far |
| `updatedRelationships` | number | Relationships whose types were changed |
| `prunedNodes` | number | Nodes removed (non-zero only when `prune: true` was set) |
| `prunedRelationships` | number | Relationships removed (non-zero only when `prune: true` was set) |

## Example

**Request:**
```http
GET /v1/schema/reconcile/aex_reconcile_abc123
```

**Response:**
```json
{
  "status": "running",
  "totalNodes": 15420,
  "processedNodes": 8200,
  "updatedNodes": 312,
  "totalRelationships": 43100,
  "processedRelationships": 21800,
  "updatedRelationships": 88,
  "prunedNodes": 0,
  "prunedRelationships": 0
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: low.
- Poll until `status` is `completed`, `failed`, or `cancelled`.
- `prunedNodes` and `prunedRelationships` are always `0` unless the job was dispatched with `prune: true`.
- A `failed` status includes partial progress — nodes and relationships processed before the failure are updated.

## Related
- `schema.reconcile.dispatch` — dispatch the reconciliation job
- `schema.version.diff` — understand what changed before reconciling
