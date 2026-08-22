# schema.registry.config

Set `enforcement_mode` and `conformance_floor` for the workspace schema registry.

## Mode
**sync**

## Surfaces
- API: `PATCH /v1/schema/registry`
- MCP: `schema.registry.config`
- Agent: callable (requires approval, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `enforcementMode` | `strict` \| `lenient` \| `off` | no | `strict` = reject writes below the conformance floor; `lenient` = warn; `off` = pass-through validation |
| `conformanceFloor` | number (0–1) | no | Threshold for strict/lenient enforcement; partial update — at least one field must be provided |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `registryId` | string | Workspace registry identifier |
| `enforcementMode` | `strict` \| `lenient` \| `off` | Active enforcement mode after update |
| `conformanceFloor` | number | Active conformance floor after update |

## Example

**Request:**
```http
PATCH /v1/schema/registry
Content-Type: application/json

{
  "enforcementMode": "strict",
  "conformanceFloor": 0.8
}
```

**Response:**
```json
{
  "registryId": "reg_ws_abc123",
  "enforcementMode": "strict",
  "conformanceFloor": 0.8
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium — changing enforcement mode affects all graph writes in the workspace.
- **Agent requires approval** before executing this action.
- Both fields are optional — at least one must be provided for a meaningful update.
- Switching from `off` to `strict` may immediately reject writes that would previously have been accepted.

## Related
- `schema.registry.get` — read current enforcement mode and conformance floor
- `schema.validate.node` — pre-flight validate a node against the active schema
- `schema.validate.relationship` — pre-flight validate a relationship against the active schema
