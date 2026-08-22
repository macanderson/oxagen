# schema.registry.get

Resolve a workspace's registry: pinned version, draft version, enforcement mode, per-schema enabled state, and the full label/relationship/property tree.

## Mode
**sync**

## Surfaces
- API: `GET /v1/schema/registry`
- MCP: `schema.registry.get`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `versionId` | string | no | Specific version to load; defaults to the currently pinned version |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `registryId` | string | Workspace registry identifier |
| `pinnedVersionId` | string \| null | Currently pinned published version ID |
| `draftVersionId` | string \| null | Current draft version ID |
| `enforcementMode` | `strict` \| `lenient` \| `off` | Per-workspace validation enforcement mode |
| `conformanceFloor` | number (0–1) | Minimum conformance score before a node write is rejected |
| `schemas` | object[] | Array of schema summaries |
| `schemas[].schemaName` | string | Schema identifier |
| `schemas[].displayName` | string | Human label |
| `schemas[].source` | `user` \| `connector` \| `recommended` | Who created the schema |
| `schemas[].connectorId` | string \| undefined | Owning connector (connector schemas only) |
| `schemas[].enabled` | boolean | Whether the schema is active |
| `schemas[].labels` | object[] | Node label definitions |
| `schemas[].labels[].name` | string | Label name |
| `schemas[].labels[].displayName` | string | Human label |
| `schemas[].labels[].description` | string \| null | Optional description |
| `schemas[].relationshipTypes` | object[] | Relationship type definitions |
| `schemas[].relationshipTypes[].name` | string | Type name |
| `schemas[].relationshipTypes[].displayName` | string | Human label |
| `schemas[].relationshipTypes[].startLabel` | string \| null | Start node label constraint |
| `schemas[].relationshipTypes[].endLabel` | string \| null | End node label constraint |

## Example

**Request:**
```http
GET /v1/schema/registry
```

**Response:**
```json
{
  "registryId": "reg_ws_abc123",
  "pinnedVersionId": "ver_005",
  "draftVersionId": "ver_006_draft",
  "enforcementMode": "lenient",
  "conformanceFloor": 0.7,
  "schemas": [
    {
      "schemaName": "crm",
      "displayName": "CRM",
      "source": "user",
      "enabled": true,
      "labels": [
        {
          "name": "Customer",
          "displayName": "Customer",
          "description": "A B2B customer account"
        }
      ],
      "relationshipTypes": [
        {
          "name": "SIGNED_CONTRACT",
          "displayName": "Signed Contract",
          "startLabel": "Customer",
          "endLabel": "Contract"
        }
      ]
    }
  ]
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: medium — returns the full structural tree of the workspace schema.
- When `versionId` is provided, loads that version's label/property tree instead of the pinned version.
- Use `schema.list` for a lightweight listing without the full tree.

## Related
- `schema.list` — lightweight listing without the full label/property tree
- `schema.version.list` — list all published versions with metadata
- `schema.registry.config` — update enforcement mode and conformance floor
