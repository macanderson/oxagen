# schema.property.upsert

Create or update a property on a node label or relationship type in the current draft version. Changes are staged in the draft — publish via `schema.version.create` or `schema.toggle` to make them live.

## Mode
**sync**

## Surfaces
- API: `PUT /v1/schemas/properties`
- MCP: `schema.property.upsert`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerKind` | `node` \| `relationship` | yes | Whether the property belongs to a node label or a relationship type |
| `ownerName` | string | yes | The label or relationship type name that owns this property |
| `key` | string (1–200 chars) | yes | Property name |
| `dataType` | `string` \| `number` \| `integer` \| `boolean` \| `date` \| `datetime` \| `url` \| `email` \| `enum` \| `json` \| `array` | yes | Property data type |
| `required` | boolean | no | Whether this property is required; default `false` |
| `description` | string (max 2000 chars) | no | Grounding description for the extraction AI |
| `enumValues` | string[] | no | When `dataType=enum`, the allowed values |
| `itemType` | string | no | When `dataType=array`, the element type |
| `constraints` | object | no | Validation constraints: `min`, `max`, `minLength`, `maxLength`, `pattern` |
| `example` | string | no | Few-shot grounding example for the extraction prompt |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `propertyId` | string | Unique identifier for the property definition |
| `created` | boolean | True if newly created; false if updated |

## Example

**Request:**
```http
PUT /v1/schemas/properties
Content-Type: application/json

{
  "ownerKind": "node",
  "ownerName": "Customer",
  "key": "tier",
  "dataType": "enum",
  "required": false,
  "description": "Pricing tier of the customer",
  "enumValues": ["free", "growth", "enterprise"],
  "example": "enterprise"
}
```

**Response:**
```json
{
  "propertyId": "prop_cust_tier_001",
  "created": true
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- Writes to the **draft version only**. Call `schema.version.create` to publish.
- `description` and `example` are used as few-shot grounding for the extraction AI — write them as if briefing an LLM.
- `constraints.pattern` must be a valid JavaScript RegExp string.

## Related
- `schema.property.delete` — remove a property from the draft
- `schema.label.upsert` — add properties inline when creating a label
- `schema.relationship.upsert` — add properties inline when creating a relationship type
