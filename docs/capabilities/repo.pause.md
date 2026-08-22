# repo.pause

Pause automatic syncing for a repository connection.

## Mode
**sync**

## Surfaces
- API: `POST /v1/repos/:id/pause`
- MCP: `repo.pause`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | string | yes | Repository connection ID |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `repoId` | string | Repository connection ID |
| `status` | `"paused"` | Confirms the connection is now paused |
| `pausedAt` | string | ISO-8601 timestamp when paused |

## Example

**Request:**
```http
POST /v1/repos/repo_abc123/pause
```

**Response:**
```json
{
  "repoId": "repo_abc123",
  "status": "paused",
  "pausedAt": "2026-06-10T14:30:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Pausing halts all scheduled polling and webhook-triggered syncs. In-flight sync jobs continue to completion.
- Manual syncs via `repo.sync` are still permitted while paused.
- Use `repo.resume` to re-enable automatic syncing.

## Related
- `repo.resume` — resume automatic syncing
- `repo.sync` — trigger a manual sync while paused
- `repo.metrics` — check current status and last sync time
- `integration.configure` — change `syncCadence` to `manual` as an alternative to pausing
