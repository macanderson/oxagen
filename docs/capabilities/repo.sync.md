# repo.sync

Trigger incremental or full re-index of a repository connection.

## Mode
**async**

## Surfaces
- API: `POST /v1/repos/:id/sync`
- MCP: `repo.sync`
- Agent: callable (no approval required, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | string | yes | Repository connection ID |
| `mode` | `"incremental"` \| `"full"` | no | Sync mode — `incremental` since last cursor (default) or `full` from scratch |
| `recordTypes` | string[] | no | Restrict sync to these record types |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | Background sync job ID |
| `status` | `"queued"` | Always `queued` on initial dispatch |
| `mode` | string | Active sync mode (`incremental` or `full`) |
| `estimatedRecords` | number | Estimated number of records to process |

## Example

**Request:**
```http
POST /v1/repos/repo_abc123/sync
Content-Type: application/json

{
  "mode": "full"
}
```

**Response (202):**
```json
{
  "jobId": "job_xyz789",
  "status": "queued",
  "mode": "full",
  "estimatedRecords": 4200
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Async:** Returns `202 Accepted` immediately; poll the background job or listen for a webhook completion event.
- `full` mode resets the sync cursor and re-processes all records. Use sparingly — it may take minutes to hours for large repositories.
- `incremental` mode only processes records changed since the last successful sync.

## Related
- `repo.configure` — configure filters, cadence, and inference settings
- `repo.pause` — pause automatic syncing
- `repo.metrics` — view sync statistics and job history
- `integration.sync` — equivalent for non-repository plugin instances
