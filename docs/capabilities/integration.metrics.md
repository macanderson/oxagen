# integration.metrics

Get sync statistics and metrics for a plugin instance.

## Mode
**sync**

## Surfaces
- API: `GET /v1/integrations/:id/metrics`
- MCP: `integration.metrics`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `integrationId` | string | yes | Plugin instance ID |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `integrationId` | string | Plugin instance ID |
| `pluginId` | string | Plugin type identifier |
| `displayName` | string | Human-readable display name |
| `status` | string | Current status: `active`, `paused`, `failed`, or `pending_setup` |
| `entityCount` | number | Total entities ingested |
| `entityCountByType` | Record\<string, number\> | Entity count breakdown by type |
| `lastSyncAt` | string \| null | ISO-8601 timestamp of last successful sync |
| `lastSyncDurationMs` | number \| null | Duration of last sync in milliseconds |
| `lastErrorAt` | string \| null | ISO-8601 timestamp of last error |
| `errorMessage` | string \| null | Most recent error message |

## Example

**Request:**
```http
GET /v1/integrations/intg_def789/metrics
```

**Response:**
```json
{
  "integrationId": "intg_def789",
  "pluginId": "jira",
  "displayName": "Jira — Platform team",
  "status": "active",
  "entityCount": 1820,
  "entityCountByType": {
    "issue": 1650,
    "sprint": 170
  },
  "lastSyncAt": "2026-06-10T14:00:00Z",
  "lastSyncDurationMs": 18500,
  "lastErrorAt": null,
  "errorMessage": null
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- `entityCountByType` reflects the last completed sync; it may lag after a sync is in progress.

## Related
- `integration.sync` — trigger a sync
- `integration.configure` — update sync config
- `repo.metrics` — equivalent for repository connectors
