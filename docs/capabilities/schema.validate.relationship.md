# schema.validate.relationship

Validate a relationship's type and properties against the workspace schema. Returns a conformance score, field-level errors, and the outcome that would occur in the current enforcement mode. Pure validation — no writes to the graph.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/validate/relationship`
- MCP: `schema.validate.relationship`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | yes | Relationship type to validate |
| `startLabel` | string | yes | Label of the start node |
| `endLabel` | string | yes | Label of the end node |
| `properties` | record<string, unknown> | yes | Property key-value map to validate |
| `versionId` | string | no | Schema version to validate against; defaults to the pinned version |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | True if the relationship passes schema validation |
| `conformanceScore` | number (0–1) | Fraction of required properties present and valid |
| `errors` | object[] | Field-level validation errors |
| `errors[].field` | string | Property key that failed validation |
| `errors[].message` | string | Human-readable error message |
| `errors[].code` | string | Machine-readable error code |
| `missingRequired` | string[] | Required property keys that are absent |
| `outcome` | `accepted` \| `rejected` \| `written_below_floor` | What would happen in the current enforcement mode |

## Example

**Request:**
```http
POST /v1/schema/validate/relationship
Content-Type: application/json

{
  "type": "SIGNED_CONTRACT",
  "startLabel": "Customer",
  "endLabel": "Contract",
  "properties": {
    "signedDate": "2026-06-01"
  }
}
```

**Response:**
```json
{
  "valid": true,
  "conformanceScore": 1.0,
  "errors": [],
  "missingRequired": [],
  "outcome": "accepted"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: low — pure validation, no mutations.
- Validates both label constraints (`startLabel`/`endLabel` must match the schema definition) and property constraints.
- `outcome` reflects what would happen if this relationship were submitted to `graph.relationship.upsert` under the current enforcement mode.
- Useful as a pre-flight check before bulk ingestion.

## Related
- `schema.validate.node` — validate a node's properties
- `schema.registry.get` — inspect the active schema definition including relationship type constraints
- `graph.relationship.upsert` — the write path that this validates against
