# schema.reconcile.dispatch

Dispatch an async reconciliation job to re-label existing graph nodes and relationships against the pinned schema version. Optionally prunes nodes and relationships that cannot be mapped to any schema label or type.

## Mode
**async**

## Surfaces
- API: `POST /v1/schema/reconcile`
- MCP: `schema.reconcile.dispatch`
- Agent: callable (requires approval, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `versionId` | string | yes | Schema version to reconcile against |
| `prune` | boolean | no | Remove nodes/relationships that cannot be mapped to any label in the schema; default `false` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `executionId` | string | Agent execution ID (`aex_…`) — poll status via `schema.reconcile.status` |

## Example

**Request:**
```http
POST /v1/schema/reconcile
Content-Type: application/json

{
  "versionId": "ver_007",
  "prune": false
}
```

**Response (202 Accepted):**
```json
{
  "executionId": "aex_reconcile_abc123"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: **destructive** — with `prune: true`, any node or relationship that cannot map to the schema is permanently removed from the graph.
- **Agent requires approval** before executing this action.
- Returns `202 Accepted` immediately. Poll `schema.reconcile.status` with the returned `executionId` to track progress.
- Use `schema.version.diff` to review structural changes before dispatching, especially when `prune: true`.
- Reconciliation is idempotent — re-running against the same version is safe and will update labels only where needed.

## Related
- `schema.reconcile.status` — poll the progress and outcome of this job
- `schema.version.diff` — review changes before reconciling
- `schema.version.pin` — pin a version before reconciling against it
