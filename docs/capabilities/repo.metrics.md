# repo.metrics

Get sync statistics and metrics for a repository connection.

## Mode
**sync**

## Surfaces
- API: `GET /v1/repos/:id/metrics`
- MCP: `repo.metrics`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | string | yes | Repository connection ID |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `repoId` | string | Repository connection ID |
| `displayName` | string | Human-readable name for the repository |
| `status` | string | Current status: `pending_setup`, `active`, `paused`, or `failed` |
| `entityCount` | number | Total entities ingested from this repository |
| `entityCountByType` | Record\<string, number\> | Entity count breakdown by type |
| `lastSyncAt` | string \| null | ISO-8601 timestamp of last successful sync |
| `lastSyncDurationMs` | number \| null | Duration of last sync in milliseconds |
| `lastErrorAt` | string \| null | ISO-8601 timestamp of last error |
| `errorMessage` | string \| null | Most recent error message |
| `syncIntervalSeconds` | integer \| null | Active polling interval, null if not polling |
| `estimatedNextSyncAt` | string \| null | Estimated next scheduled sync |

## Example

**Request:**
```http
GET /v1/repos/repo_abc123/metrics
```

**Response:**
```json
{
  "repoId": "repo_abc123",
  "displayName": "acme/backend",
  "status": "active",
  "entityCount": 4250,
  "entityCountByType": {
    "pull_request": 312,
    "issue": 850,
    "commit": 3088
  },
  "lastSyncAt": "2026-06-10T14:00:00Z",
  "lastSyncDurationMs": 42300,
  "lastErrorAt": null,
  "errorMessage": null,
  "syncIntervalSeconds": 3600,
  "estimatedNextSyncAt": "2026-06-10T15:00:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Read-only; no side effects.
- `entityCountByType` reflects the last ingested state; it may lag slightly after a sync completes.

## Related
- `repo.sync` — trigger a sync
- `repo.configure` — update sync cadence and filters
- `integration.metrics` — equivalent for non-repository plugin instances
