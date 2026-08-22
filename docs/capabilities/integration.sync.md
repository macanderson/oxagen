# integration.sync

Trigger synchronization of a plugin instance.

## Mode
**async**

## Surfaces
- API: `POST /v1/integrations/:id/sync`
- MCP: `integration.sync`
- Agent: callable (no approval required, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `integrationId` | string | yes | Plugin instance ID |
| `mode` | `"incremental"` \| `"full"` | no | Sync mode — `incremental` since last cursor (default) or `full` from scratch |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | Background sync job ID |
| `status` | `"queued"` | Always `queued` on initial dispatch |
| `integrationId` | string | Plugin instance ID |
| `mode` | string | Active sync mode |

## Example

**Request:**
```http
POST /v1/integrations/intg_def789/sync
Content-Type: application/json

{
  "mode": "incremental"
}
```

**Response (202):**
```json
{
  "jobId": "job_xyz101",
  "status": "queued",
  "integrationId": "intg_def789",
  "mode": "incremental"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Async:** Returns `202 Accepted` immediately; monitor via job status or webhook.
- `full` mode resets the sync cursor and re-processes all data from the source. Use for post-configuration changes.
- Calling sync on a `paused` integration will queue the job, but it will not auto-resume the integration.

## Related
- `integration.configure` — configure sync cadence and inference
- `integration.metrics` — view sync statistics
- `repo.sync` — equivalent for repository connectors
