# schema.label.delete

Remove a node label and all its properties from the current draft version. Does not affect published versions — publish a new version to make the deletion permanent.

## Mode
**sync**

## Surfaces
- API: `DELETE /v1/schemas/{schemaName}/labels/{name}`
- MCP: `schema.label.delete`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | yes | Target schema |
| `name` | string | yes | Label name to remove |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `deleted` | boolean | True if the label existed and was removed |
| `labelName` | string | The label that was deleted |

## Example

**Request:**
```http
DELETE /v1/schemas/crm/labels/LegacyAccount
```

**Response:**
```json
{
  "deleted": true,
  "labelName": "LegacyAccount"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: high — removes the label and all its properties from the draft.
- **Agent requires approval** before executing this action.
- Deletion is staged in the **draft version only**. Call `schema.version.create` to publish the deletion.
- Deleting a label does not remove existing graph nodes with that label — those remain until `schema.reconcile.dispatch` is run with `prune: true`.
- Returns `deleted: false` if the label does not exist (idempotent — not an error).

## Related
- `schema.label.upsert` — create or update a node label
- `schema.property.delete` — remove a single property from a label
- `schema.version.create` — publish the draft to make the deletion permanent
