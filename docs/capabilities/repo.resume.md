# repo.resume

Resume automatic syncing for a paused repository connection.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos/:id/resume`
- MCP: `repo.resume`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | string | yes | Repository connection ID |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `repoId` | string | Repository connection ID |
| `status` | `"active"` | Confirms the connection is now active |
| `resumedAt` | string | ISO-8601 timestamp when resumed |
| `nextSyncAt` | string \| null | Estimated next scheduled sync time, null if cadence is manual |

## Example

**Request:**
```http
POST /v1/repos/repo_abc123/resume
```

**Response:**
```json
{
  "repoId": "repo_abc123",
  "status": "active",
  "resumedAt": "2026-06-10T15:00:00Z",
  "nextSyncAt": "2026-06-10T16:00:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Resuming restores the sync cadence configured via `repo.configure`. If `syncCadence` is `manual`, `nextSyncAt` will be null.
- An immediate incremental sync is not triggered automatically on resume; call `repo.sync` if needed.

## Related
- `repo.pause` — pause automatic syncing
- `repo.sync` — trigger an immediate sync after resuming
- `repo.metrics` — confirm status and next sync schedule
