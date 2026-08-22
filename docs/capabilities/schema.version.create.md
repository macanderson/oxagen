# schema.version.create

Freeze the current draft into an immutable published version and open a fresh empty draft. Does not automatically pin the new version — use `schema.version.pin` or `schema.toggle` to pin.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/versions`
- MCP: `schema.version.create`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `label` | string (max 200 chars) | no | Human tag, e.g. `"Sales CRM v2"` |
| `changeSummary` | string (max 2000 chars) | no | Description of what changed in this version |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `versionId` | string | ID of the newly published version |
| `versionNumber` | number | Monotonically increasing version number |
| `publishedAt` | string | ISO-8601 timestamp of publication |

## Example

**Request:**
```http
POST /v1/schema/versions
Content-Type: application/json

{
  "label": "Sales CRM v2",
  "changeSummary": "Added Contract label and SIGNED_CONTRACT relationship; removed LegacyAccount label"
}
```

**Response:**
```json
{
  "versionId": "ver_007",
  "versionNumber": 7,
  "publishedAt": "2026-06-23T14:00:00Z"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner only.
- Sensitivity: medium.
- The draft is frozen as an immutable snapshot; a new empty draft is opened immediately.
- Does **not** auto-pin the new version. Call `schema.version.pin` to update the workspace to the new version, or use `schema.toggle` which publishes and pins atomically.
- The draft must contain at least one schema with at least one label or relationship type — empty drafts cannot be published.

## Related
- `schema.version.pin` — pin the workspace to this new version
- `schema.version.list` — list all versions including the new one
- `schema.toggle` — alternative that publishes and pins in one atomic step
