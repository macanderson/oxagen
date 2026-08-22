# integration.install

Install a plugin instance from the catalog or a custom URL. Fetches schema, validates config, and installs in workspace scope.

## Mode
**async**

## Surfaces
- API: `POST /v1/integrations`
- MCP: `integration.install`
- Agent: callable (requires approval, risk: high)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pluginId` | string | yes | Plugin identifier from catalog (e.g., `github`, `google-drive`) |
| `version` | string | no | Plugin version; uses latest if omitted |
| `schemaUrl` | string (URL) | no | For custom plugins: HTTPS URL to fetch `schema.yaml` from |
| `config` | Record\<string, unknown\> | yes | Plugin configuration matching the plugin schema |
| `displayName` | string | yes | Human-readable display name for this plugin instance |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `jobId` | string | Background install job ID |
| `status` | `"queued"` | Always `queued` on initial dispatch |
| `pluginId` | string | Plugin identifier |
| `displayName` | string | Display name of the new plugin instance |

## Example

**Request:**
```http
POST /v1/integrations
Content-Type: application/json

{
  "pluginId": "github",
  "displayName": "GitHub — acme org",
  "config": {
    "organizations": ["acme"],
    "recordTypes": ["pull_request", "issue"],
    "inferenceEnabled": true
  }
}
```

**Response (202):**
```json
{
  "jobId": "job_abc456",
  "status": "queued",
  "pluginId": "github",
  "displayName": "GitHub — acme org"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- **Agent requires approval** before executing this action due to high risk level.
- **Async:** Returns `202 Accepted`; the install job fetches the schema, provisions credentials, and runs the first sync.
- Use `plugin.schema.get` to retrieve the schema before constructing the `config` payload.
- Use `plugin.schema.validate` to validate `config` client-side before calling `integration.install`.
- Custom plugins (`schemaUrl`) must serve a valid `schema.yaml` at the provided HTTPS URL.
- The resulting integration can be monitored via `integration.get` and `integration.metrics`.

## Related
- `plugin.schema.get` — fetch plugin config schema for form rendering
- `plugin.schema.validate` — validate config before install
- `integration.configure` — update config after installation
- `integration.delete` — remove a plugin instance
- `integration.list` — list all installed integrations
