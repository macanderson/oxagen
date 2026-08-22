# plugin.version.list

List version history for a connector plugin, including changelog entries and breaking-change flags. Used by org admins to review update impact before upgrading.

## Mode
**sync**

## Surfaces
- API: `GET /v1/plugin-versions/:pluginId`
- MCP: `plugin.version.list`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pluginId` | string | yes | Connector plugin identifier (e.g., `github`, `google-drive`) |
| `limit` | integer (1–50) | no | Maximum number of versions to return, newest first; default 20 |
| `includeChangelog` | boolean | no | When `true`, include full markdown changelog per version; default `false` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `pluginId` | string | Plugin identifier |
| `currentVersion` | string | Latest available version |
| `installedVersion` | string \| null | Version installed for this org, or null if not installed |
| `hasBreakingUpdate` | boolean | `true` when any version between `installedVersion` and `currentVersion` contains breaking changes |
| `versions` | object[] | Version history entries, newest first |
| `versions[].version` | string | SemVer version string |
| `versions[].releasedAt` | string | ISO-8601 release timestamp |
| `versions[].isBreaking` | boolean | `true` when this version has breaking config schema changes |
| `versions[].breakingChanges` | string[] \| undefined | Descriptions of breaking changes (only present when `isBreaking` is `true`) |
| `versions[].changelog` | string \| undefined | Markdown changelog (only present when `includeChangelog=true`) |
| `versions[].schemaVersion` | string | Schema format version used by this plugin version |
| `versions[].minimumPlatformVersion` | string \| undefined | Minimum Oxagen platform version required |

## Example

**Request:**
```http
GET /v1/plugin-versions/github?limit=3&includeChangelog=true
```

**Response:**
```json
{
  "pluginId": "github",
  "currentVersion": "1.4.0",
  "installedVersion": "1.2.0",
  "hasBreakingUpdate": true,
  "versions": [
    {
      "version": "1.4.0",
      "releasedAt": "2026-06-01T00:00:00Z",
      "isBreaking": false,
      "changelog": "### 1.4.0\n- Added commit author enrichment",
      "schemaVersion": "1.0.0"
    },
    {
      "version": "1.3.0",
      "releasedAt": "2026-05-15T00:00:00Z",
      "isBreaking": true,
      "breakingChanges": ["Renamed config field `orgName` → `organizations` (now array)"],
      "changelog": "### 1.3.0\n- Support multiple organizations",
      "schemaVersion": "1.0.0",
      "minimumPlatformVersion": "0.3.0"
    },
    {
      "version": "1.2.0",
      "releasedAt": "2026-04-01T00:00:00Z",
      "isBreaking": false,
      "schemaVersion": "1.0.0"
    }
  ]
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Not workspace-scoped — returns the same version history for all callers with org membership.
- `hasBreakingUpdate` is a shortcut flag; check individual `breakingChanges` arrays before upgrading.
- Plugin upgrades are performed via `integration.configure` (version field).

## Related
- `plugin.schema.get` — fetch the schema for a specific version
- `plugin.catalog.get` — full catalog entry with publisher and category metadata
- `integration.configure` — upgrade an installed plugin
