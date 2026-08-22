# schema.property.delete

Remove a property from a node label or relationship type in the current draft version. Does not affect published versions — publish a new version to make the deletion permanent.

## Mode
**sync**

## Surfaces
- API: `DELETE /v1/schemas/properties`
- MCP: `schema.property.delete`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerKind` | `node` \| `relationship` | yes | Whether the property is on a node label or a relationship type |
| `ownerName` | string | yes | The label or relationship type name that owns the property |
| `key` | string | yes | Property name to remove |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `deleted` | boolean | True if the property existed and was removed |
| `propertyKey` | string | The property key that was deleted |

## Example

**Request:**
```http
DELETE /v1/schemas/properties
Content-Type: application/json

{
  "ownerKind": "node",
  "ownerName": "Customer",
  "key": "legacyAccountCode"
}
```

**Response:**
```json
{
  "deleted": true,
  "propertyKey": "legacyAccountCode"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: high — removes the property definition from the draft.
- **Agent requires approval** before executing this action.
- Deletion is staged in the **draft version only**. Call `schema.version.create` to publish.
- Deleting a property does not remove the corresponding data from existing graph nodes — those values remain until overwritten or pruned.
- Returns `deleted: false` if the property does not exist (idempotent — not an error).

## Related
- `schema.property.upsert` — create or update a property
- `schema.label.delete` — remove the entire label (and all its properties)
- `schema.relationship.delete` — remove the entire relationship type (and all its properties)
