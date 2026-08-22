# integration.list

Browse installed plugin instances with status, config summary, and sync metrics.

## Mode
**sync**

## Surfaces
- API: `GET /v1/integrations`
- MCP: `integration.list`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | `"active"` \| `"paused"` \| `"failed"` \| `"pending_setup"` | no | Filter by status |
| `pluginId` | string | no | Filter by plugin type (e.g., `github`) |
| `limit` | integer (1–250) | no | Results per page, default 50 |
| `offset` | integer | no | Pagination offset, default 0 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `integrations` | object[] | Array of plugin instance summaries |
| `integrations[].id` | string | Plugin instance ID |
| `integrations[].pluginId` | string | Plugin type identifier |
| `integrations[].displayName` | string | Human-readable display name |
| `integrations[].status` | string | Current status |
| `integrations[].version` | string | Installed plugin version |
| `integrations[].lastSyncAt` | string \| null | ISO-8601 timestamp of last sync |
| `integrations[].entityCount` | number | Total entities ingested |
| `integrations[].errorMessage` | string \| null | Most recent error message |
| `integrations[].createdAt` | string | ISO-8601 creation timestamp |
| `total` | number | Total matching integrations (before pagination) |
| `hasMore` | boolean | Whether more pages exist |

## Example

**Request:**
```http
GET /v1/integrations?status=active&limit=10
```

**Response:**
```json
{
  "integrations": [
    {
      "id": "intg_def789",
      "pluginId": "jira",
      "displayName": "Jira — Platform team",
      "status": "active",
      "version": "2.1.0",
      "lastSyncAt": "2026-06-10T14:00:00Z",
      "entityCount": 1820,
      "errorMessage": null,
      "createdAt": "2026-05-01T09:00:00Z"
    }
  ],
  "total": 1,
  "hasMore": false
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- Use `integration.get` to retrieve full config details for a specific instance.

## Related
- `integration.get` — full details for a single integration
- `integration.install` — install a new plugin instance
- `integration.metrics` — detailed sync statistics
