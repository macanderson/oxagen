# schema.list

List the workspace's schemas with per-schema enabled state. Lightweight listing without the full label/property tree.

## Mode
**sync**

## Surfaces
- API: `GET /v1/schemas`
- MCP: `schema.list`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | — | — | No input parameters |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `schemas` | object[] | Array of schema summaries |
| `schemas[].schemaName` | string | Schema identifier |
| `schemas[].displayName` | string | Human label |
| `schemas[].source` | `user` \| `connector` \| `recommended` | Who created the schema |
| `schemas[].connectorId` | string \| null \| undefined | Owning connector (connector schemas only) |
| `schemas[].enabled` | boolean | Whether the schema is active |

## Example

**Request:**
```http
GET /v1/schemas
```

**Response:**
```json
{
  "schemas": [
    {
      "schemaName": "crm",
      "displayName": "CRM",
      "source": "user",
      "connectorId": null,
      "enabled": true
    },
    {
      "schemaName": "github",
      "displayName": "GitHub",
      "source": "connector",
      "connectorId": "conn_github_xyz",
      "enabled": false
    }
  ]
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: medium.
- Returns a flat list without the full label/relationship/property tree. Use `schema.registry.get` for the full structural tree.
- Connector-sourced schemas include the `connectorId` that owns them.

## Related
- `schema.registry.get` — full structural tree including labels, relationship types, and properties
- `schema.toggle` — enable or disable a schema
- `schema.label.upsert` — add or update a node label on a schema
