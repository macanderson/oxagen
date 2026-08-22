# schema.toggle

Enable or disable a schema. Activation auto-publishes the current draft and auto-pins the resulting version — no separate publish/pin step is needed.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schemas/{schemaName}/toggle`
- MCP: `schema.toggle`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | yes | Schema to enable or disable |
| `enabled` | boolean | yes | Target enabled state |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `schemaName` | string | Schema that was toggled |
| `enabled` | boolean | Resulting enabled state |
| `publishedVersionId` | string \| null | Version published on enable (null if disabling) |
| `pinnedVersionId` | string \| null | Version now pinned (null if disabling) |
| `isDowngrade` | boolean | True if re-enabling pinned an older version |
| `reconcileRecommended` | boolean | True if existing graph data may be out of sync with the newly pinned version |

## Example

**Request:**
```http
POST /v1/schemas/crm/toggle
Content-Type: application/json

{
  "enabled": true
}
```

**Response:**
```json
{
  "schemaName": "crm",
  "enabled": true,
  "publishedVersionId": "ver_007",
  "pinnedVersionId": "ver_007",
  "isDowngrade": false,
  "reconcileRecommended": false
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner only.
- Sensitivity: high — enabling a schema affects all subsequent graph writes in the workspace.
- **Agent requires approval** before executing this action.
- **Enable:** auto-publishes the current draft as an immutable version and auto-pins it. The draft and pin happen atomically — no separate `schema.version.create` or `schema.version.pin` call is needed.
- **Disable:** de-activates schema validation without removing graph data. The pinned version is set to null.
- If `reconcileRecommended` is true, consider running `schema.reconcile.dispatch` to re-label existing graph data.

## Related
- `schema.registry.get` — verify the registry state after toggling
- `schema.version.pin` — pin a specific published version without toggling
- `schema.reconcile.dispatch` — re-label existing graph data against the pinned version
