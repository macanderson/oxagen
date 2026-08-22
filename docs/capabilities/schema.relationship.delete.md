# schema.relationship.delete

Remove a relationship type from the current draft version. Does not affect published versions — publish a new version to make the deletion permanent.

## Mode
**sync**

## Surfaces
- API: `DELETE /v1/schemas/{schemaName}/relationships/{name}`
- MCP: `schema.relationship.delete`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | yes | Target schema |
| `name` | string | yes | Relationship type name to remove |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `deleted` | boolean | True if the type existed and was removed |
| `relationshipTypeName` | string | The relationship type that was deleted |

## Example

**Request:**
```http
DELETE /v1/schemas/crm/relationships/LEGACY_LINK
```

**Response:**
```json
{
  "deleted": true,
  "relationshipTypeName": "LEGACY_LINK"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: high — removes the relationship type and all its properties from the draft.
- **Agent requires approval** before executing this action.
- Deletion is staged in the **draft version only**. Call `schema.version.create` to publish.
- Deleting a relationship type does not remove existing graph relationships of that type — those remain until `schema.reconcile.dispatch` is run with `prune: true`.
- Returns `deleted: false` if the type does not exist (idempotent — not an error).

## Related
- `schema.relationship.upsert` — create or update a relationship type
- `schema.property.delete` — remove a single property from a relationship type
- `schema.version.create` — publish the draft to make the deletion permanent
