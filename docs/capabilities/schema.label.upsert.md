# schema.label.upsert

Create or update a node label on a schema within the current draft version. Changes are staged in the draft — publish via `schema.version.create` or `schema.toggle` to make them live.

## Mode
**sync**

## Surfaces
- API: `PUT /v1/schemas/{schemaName}/labels/{name}`
- MCP: `schema.label.upsert`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `schemaName` | string | yes | Target schema |
| `name` | string (1–200 chars) | yes | Node label name (e.g. `Customer`, `Contract`) |
| `displayName` | string (1–200 chars) | yes | Human-readable label name |
| `description` | string (max 2000 chars) | no | Optional description for grounding the extraction AI |
| `naturalKeyProps` | string[] | no | Property names forming the dedup natural key (used for MERGE on ingest) |
| `properties` | PropertyInput[] | no | Inline property definitions (see `schema.property.upsert` for the property shape) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `labelId` | string | Unique identifier for the label definition |
| `created` | boolean | True if newly created; false if updated |

## Example

**Request:**
```http
PUT /v1/schemas/crm/labels/Customer
Content-Type: application/json

{
  "name": "Customer",
  "displayName": "Customer",
  "description": "A B2B customer account tracked in the CRM",
  "naturalKeyProps": ["domain"],
  "properties": [
    {
      "key": "domain",
      "dataType": "string",
      "required": true,
      "description": "Primary domain of the customer (e.g. acme.com)"
    }
  ]
}
```

**Response:**
```json
{
  "labelId": "lbl_cust_001",
  "created": true
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- Writes to the **draft version only**. Call `schema.version.create` to publish the draft, or `schema.toggle` to publish and pin atomically.
- Providing `properties` inline is equivalent to calling `schema.property.upsert` for each property after the label is created.
- `naturalKeyProps` drives the `MERGE` key used during graph ingestion to deduplicate nodes.

## Related
- `schema.label.delete` — remove a node label from the draft
- `schema.property.upsert` — add or update individual properties on this label
- `schema.version.create` — publish the draft as an immutable version
