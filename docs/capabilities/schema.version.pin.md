# schema.version.pin

Point the workspace at a specific published schema version. Returns whether a downgrade occurred and whether reconciliation is recommended.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/versions/{versionId}/pin`
- MCP: `schema.version.pin`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `versionId` | string | yes | The published version to pin |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `pinnedVersionId` | string | The version now pinned |
| `previousVersionId` | string \| null | The version that was pinned before (null if none) |
| `isDowngrade` | boolean | True if pinning to an older version number |
| `reconcileRecommended` | boolean | True if existing graph data may need reconciliation against the newly pinned version |

## Example

**Request:**
```http
POST /v1/schema/versions/ver_005/pin
```

**Response:**
```json
{
  "pinnedVersionId": "ver_005",
  "previousVersionId": "ver_007",
  "isDowngrade": true,
  "reconcileRecommended": true
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner only.
- Sensitivity: high — changing the pinned version immediately affects all schema validation for graph writes.
- **Agent requires approval** before executing this action.
- Downgrading the pinned version (pointing to an older version number) may cause graph data to fail validation against the older schema. Use `schema.version.diff` to review differences before pinning.
- If `reconcileRecommended` is true, consider running `schema.reconcile.dispatch` to re-label existing graph data.
- Only published versions can be pinned — draft versions cannot.

## Related
- `schema.version.create` — publish the draft before pinning
- `schema.version.diff` — review structural changes between versions before pinning
- `schema.reconcile.dispatch` — re-label existing graph data against the newly pinned version
