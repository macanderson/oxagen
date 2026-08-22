# schema.validate.node

Validate a node's properties against the workspace schema. Returns a conformance score, field-level errors, and the outcome that would occur in the current enforcement mode. Pure validation — no writes to the graph.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/validate/node`
- MCP: `schema.validate.node`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `label` | string | yes | Node label to validate against |
| `properties` | record<string, unknown> | yes | Property key-value map to validate |
| `versionId` | string | no | Schema version to validate against; defaults to the pinned version |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | True if the node passes schema validation |
| `conformanceScore` | number (0–1) | Fraction of required properties present and valid |
| `errors` | object[] | Field-level validation errors |
| `errors[].field` | string | Property key that failed validation |
| `errors[].message` | string | Human-readable error message |
| `errors[].code` | string | Machine-readable error code |
| `missingRequired` | string[] | Required property keys that are absent |
| `outcome` | `accepted` \| `rejected` \| `written_below_floor` | What would happen to this node under the current enforcement mode |

## Example

**Request:**
```http
POST /v1/schema/validate/node
Content-Type: application/json

{
  "label": "Customer",
  "properties": {
    "tier": "premium",
    "domain": "acme.com"
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
- `outcome` reflects what governed ingestion would do under the current enforcement mode: `accepted` = passes, `rejected` = blocked by strict enforcement, `written_below_floor` = admitted but flagged.
- Useful as a pre-flight check before bulk ingestion.

## Related
- `schema.validate.relationship` — validate a relationship's type and properties
- `schema.registry.get` — inspect the active schema definition
- Connector ingestion is the governed graph write path. Semantic candidate approval is not a launch capability.
