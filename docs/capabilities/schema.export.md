# schema.export

Build a ZIP of a schema version (grouped by schema) via the `archive.create` plumbing and return an access-controlled download URL.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/export`
- MCP: `schema.export`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `versionId` | string | no | Version to export; defaults to the currently pinned version |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `assetId` | string | Asset ID for the exported ZIP in blob storage |
| `serveUrl` | string | Access-controlled download URL for the ZIP |
| `versionId` | string | The version that was exported |
| `versionNumber` | number | The version number that was exported |

## Example

**Request:**
```http
POST /v1/schema/export
Content-Type: application/json

{
  "versionId": "ver_007"
}
```

**Response:**
```json
{
  "assetId": "ast_schema_export_abc123",
  "serveUrl": "https://api.oxagen.sh/v1/assets/ast_schema_export_abc123",
  "versionId": "ver_007",
  "versionNumber": 7
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- The ZIP contains one JSON file per schema, each containing its labels, relationship types, and properties.
- `serveUrl` is access-controlled — callers must present a valid API key or session cookie to download.
- The asset is stored in blob storage and is accessible via the `asset.upload` / asset serve path.

## Related
- `schema.version.list` — discover available version IDs for export
- `schema.registry.get` — inspect the schema structure before exporting
- `archive.create` — underlying archive plumbing used by this capability
