# schema.relationship.upsert

Create or update a relationship type on a schema within the current draft version. Changes are staged in the draft — publish via `schema.version.create` or `schema.toggle` to make them live.

## Mode
**sync**

## Surfaces
- API: `PUT /v1/schemas/{schemaName}/relationships/{name}`
- MCP: `schema.relationship.upsert`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | yes | Target schema |
| `name` | string | yes | Relationship type name — must match `[A-Z][A-Z0-9_]{0,62}` (e.g. `EMPLOYS`, `SIGNED_CONTRACT`) |
| `displayName` | string (1–200 chars) | yes | Human-readable label |
| `startLabel` | string | no | Constrain start node to this label (null = any label) |
| `endLabel` | string | no | Constrain end node to this label (null = any label) |
| `cardinality` | `one_to_one` \| `one_to_many` \| `many_to_many` | no | Cardinality constraint |
| `description` | string (max 2000 chars) | no | Optional description for grounding the extraction AI |
| `properties` | PropertyInput[] | no | Inline property definitions (see `schema.property.upsert` for the shape) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `relationshipTypeId` | string | Unique identifier for the relationship type definition |
| `created` | boolean | True if newly created; false if updated |

## Example

**Request:**
```http
PUT /v1/schemas/crm/relationships/SIGNED_CONTRACT
Content-Type: application/json

{
  "name": "SIGNED_CONTRACT",
  "displayName": "Signed Contract",
  "startLabel": "Customer",
  "endLabel": "Contract",
  "cardinality": "one_to_many",
  "description": "A customer has signed one or more contracts"
}
```

**Response:**
```json
{
  "relationshipTypeId": "rt_signed_contract_001",
  "created": true
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- Writes to the **draft version only**. Call `schema.version.create` or `schema.toggle` to publish.
- Relationship type names are validated against the `RELATIONSHIP_TYPE_PATTERN` lexical guard (`/^[A-Z][A-Z0-9_]{0,62}$/`) to prevent Cypher injection.
- `startLabel` and `endLabel` must reference labels that exist in the same schema (or be null for unconstrained).

## Related
- `schema.relationship.delete` — remove a relationship type from the draft
- `schema.property.upsert` — add or update properties on this relationship type
- `graph.relationship.upsert` — create graph relationships using this type
