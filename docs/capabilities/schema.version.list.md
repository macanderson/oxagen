# schema.version.list

List all schema versions with version number, label, status, published timestamp, and change summary. Always includes the current draft as the first entry.

## Mode
**sync**

## Surfaces
- API: `GET /v1/schema/versions`
- MCP: `schema.version.list`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | integer (1–100) | no | Page size; default 20 |
| `offset` | integer (min 0) | no | Zero-based page offset; default 0 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `versions` | object[] | Ordered list of versions, newest first |
| `versions[].versionId` | string | Version identifier |
| `versions[].versionNumber` | number | Monotonically increasing version number |
| `versions[].status` | `draft` \| `published` | `draft` = not yet frozen; `published` = immutable |
| `versions[].label` | string \| null | Human tag if supplied at publish time |
| `versions[].changeSummary` | string \| null | Description of changes |
| `versions[].publishedAt` | string \| null | ISO-8601 publish timestamp (null for draft) |
| `versions[].isPinned` | boolean | Whether this is the currently pinned version |
| `total` | number | Total versions before pagination |

## Example

**Request:**
```http
GET /v1/schema/versions?limit=5
```

**Response:**
```json
{
  "versions": [
    {
      "versionId": "ver_008_draft",
      "versionNumber": 8,
      "status": "draft",
      "label": null,
      "changeSummary": null,
      "publishedAt": null,
      "isPinned": false
    },
    {
      "versionId": "ver_007",
      "versionNumber": 7,
      "status": "published",
      "label": "Sales CRM v2",
      "changeSummary": "Added Contract label and SIGNED_CONTRACT relationship",
      "publishedAt": "2026-06-23T14:00:00Z",
      "isPinned": true
    },
    {
      "versionId": "ver_006",
      "versionNumber": 6,
      "status": "published",
      "label": null,
      "changeSummary": null,
      "publishedAt": "2026-06-10T09:00:00Z",
      "isPinned": false
    }
  ],
  "total": 8
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member/Viewer (read-only).
- Sensitivity: medium.
- The current draft always appears first with `status: "draft"` and `publishedAt: null`.
- Use `schema.version.diff` to compare any two version IDs from this list.

## Related
- `schema.version.create` — publish the current draft as a new version
- `schema.version.pin` — pin the workspace to a specific version
- `schema.version.diff` — structural diff between two versions
