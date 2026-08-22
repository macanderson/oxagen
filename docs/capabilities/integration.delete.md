# integration.delete

Remove a plugin instance and optionally purge its graph data from Neo4j.

## Mode
**async**

## Surfaces
- API: `DELETE /v1/integrations/:id`
- MCP: `integration.delete`
- Agent: callable (requires approval, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `integrationId` | string | yes | Plugin instance ID |
| `purgeData` | boolean | no | Delete all entities and edges from this plugin in Neo4j; default `false` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | Background deletion job ID |
| `status` | `"queued"` | Always `queued` on initial dispatch |
| `integrationId` | string | Plugin instance ID |
| `purgeData` | boolean | Confirms whether graph data will be purged |

## Example

**Request:**
```http
DELETE /v1/integrations/intg_def789?purgeData=true
```

**Response (202):**
```json
{
  "jobId": "job_del456",
  "status": "queued",
  "integrationId": "intg_def789",
  "purgeData": true
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Agent requires approval** before executing this action due to destructive risk.
- **Async:** Returns `202 Accepted`; the deletion job removes the Postgres record, revokes credentials, and (if `purgeData=true`) deletes all Neo4j nodes and edges sourced from this integration.
- **Irreversible when `purgeData=true`.** Graph data cannot be recovered after purge.
- When `purgeData=false` (default), the integration record is removed but graph nodes sourced from it remain (orphaned). Use this when you intend to re-install the same plugin.

## Related
- `integration.install` — install a new plugin instance
- `integration.list` — confirm deletion after the job completes
- `integration.get` — check integration status
