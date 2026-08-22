# integration.get

Get full details of a single plugin instance including schema and configuration.

## Mode
**sync**

## Surfaces
- API: `GET /v1/integrations/:id`
- MCP: `integration.get`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `integrationId` | string | yes | Plugin instance ID |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Plugin instance ID |
| `pluginId` | string | Plugin type identifier |
| `displayName` | string | Human-readable display name |
| `version` | string | Installed plugin version |
| `status` | string | Current status: `active`, `paused`, `failed`, or `pending_setup` |
| `config` | Record\<string, unknown\> | Current configuration values |
| `schema` | Record\<string, unknown\> \| null | Plugin schema (null if not yet loaded) |
| `entityCount` | number | Total entities ingested |
| `lastSyncAt` | string \| null | ISO-8601 timestamp of last sync |
| `errorMessage` | string \| null | Most recent error message |
| `createdAt` | string | ISO-8601 creation timestamp |
| `updatedAt` | string | ISO-8601 last-update timestamp |

## Example

**Request:**
```http
GET /v1/integrations/intg_def789
```

**Response:**
```json
{
  "id": "intg_def789",
  "pluginId": "jira",
  "displayName": "Jira — Platform team",
  "version": "2.1.0",
  "status": "active",
  "config": {
    "projectKeys": ["PLAT", "INFRA"],
    "inferenceEnabled": true
  },
  "schema": { "apiVersion": "oxagen.ai/v1alpha1", "kind": "ConnectorPlugin" },
  "entityCount": 1820,
  "lastSyncAt": "2026-06-10T14:00:00Z",
  "errorMessage": null,
  "createdAt": "2026-05-01T09:00:00Z",
  "updatedAt": "2026-06-10T12:00:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- `config` may contain sensitive credential references; secrets are never returned in plain text.
- `schema` is null during `pending_setup` while the install job fetches it.

## Related
- `integration.list` — list all integrations
- `integration.configure` — update config
- `integration.metrics` — detailed sync statistics
- `plugin.schema.get` — fetch the plugin's schema definition independently
