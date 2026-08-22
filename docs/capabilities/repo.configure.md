# repo.configure

Set repo-specific configuration: filters, inference toggles, sync cadence, and field mappings. Specializes `connection.configure` for code repository connectors.

## Mode
**sync**

## Surfaces
- API: `PATCH /v1/repos/:id/configure`
- MCP: `repo.configure`
- Agent: callable (no approval required, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repoId` | string | yes | Repository connection ID (UUID or public ID) |
| `recordTypes` | string[] | no | Record types to ingest (e.g., `pull_request`, `issue`, `commit`) |
| `pathFilters.include` | string[] | no | Paths to include |
| `pathFilters.exclude` | string[] | no | Paths to exclude (e.g., `node_modules`, `dist`) |
| `labelFilters.include` | string[] | no | Labels to include |
| `labelFilters.exclude` | string[] | no | Labels to exclude |
| `inferenceEnabled` | boolean | no | Enable LLM-driven semantic inference |
| `ontologyPrompt` | string | no | Custom prompt instructing LLM on entity extraction and relationships |
| `syncCadence` | `"manual"` \| `"polling"` \| `"webhook"` | no | Sync trigger method |
| `pollingIntervalSeconds` | integer | no | Polling interval in seconds (required when `syncCadence=polling`) |
| `fieldMappings` | Record\<string, string\> | no | Custom field mappings (source field path → canonical property) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `repoId` | string | Repository connection ID |
| `displayName` | string | Human-readable name for the repository |
| `recordTypes` | string[] | Active record types |
| `pathFilters` | object \| null | Active path include/exclude filters |
| `labelFilters` | object \| null | Active label include/exclude filters |
| `inferenceEnabled` | boolean | Whether LLM inference is enabled |
| `syncCadence` | string | Active sync trigger method |
| `pollingIntervalSeconds` | integer \| null | Active polling interval, null if not polling |
| `updatedAt` | string | ISO-8601 timestamp of the update |

## Example

**Request:**
```http
PATCH /v1/repos/repo_abc123/configure
Content-Type: application/json

{
  "recordTypes": ["pull_request", "issue"],
  "pathFilters": { "exclude": ["node_modules", "dist", ".git"] },
  "inferenceEnabled": true,
  "syncCadence": "polling",
  "pollingIntervalSeconds": 3600
}
```

**Response:**
```json
{
  "repoId": "repo_abc123",
  "displayName": "acme/backend",
  "recordTypes": ["pull_request", "issue"],
  "pathFilters": { "include": [], "exclude": ["node_modules", "dist", ".git"] },
  "labelFilters": null,
  "inferenceEnabled": true,
  "syncCadence": "polling",
  "pollingIntervalSeconds": 3600,
  "updatedAt": "2026-06-10T12:00:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Risk level:** medium — changes affect ingestion scope and LLM-inference behavior.
- Changing `inferenceEnabled` or `ontologyPrompt` does not trigger an immediate re-sync; use `repo.sync` with `mode: "full"` to re-process existing data.
- Setting `syncCadence` to `polling` without `pollingIntervalSeconds` uses the plugin default.

## Related
- `repo.sync` — trigger an incremental or full re-index
- `repo.pause` / `repo.resume` — pause or resume automatic syncing
- `repo.metrics` — view sync statistics
- `integration.configure` — configure non-repository plugin instances
