# plugin.schema.get

Fetch the typed config schema for a connector plugin, used to drive dynamic form rendering during install and configure flows.

## Mode
**sync**

## Surfaces
- API: `GET /v1/plugin-schema/:pluginId`
- MCP: `plugin.schema.get`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pluginId` | string | yes | Connector plugin identifier (e.g., `github`, `google-drive`) |

## Output

Returns a full `ConnectorPlugin` schema document:

| Field | Type | Description |
|-------|------|-------------|
| `apiVersion` | `"oxagen.ai/v1alpha1"` | Schema format version |
| `kind` | `"ConnectorPlugin"` | Resource kind |
| `metadata.id` | string | Plugin identifier |
| `metadata.displayName` | string | Human-readable plugin name |
| `metadata.version` | string | Current plugin version |
| `metadata.publisher.name` | string | Publisher display name |
| `metadata.publisher.verified` | boolean | Whether publisher is verified |
| `auth` | object \| undefined | Auth scheme definitions |
| `auth.schemes[]` | object[] | List of supported auth schemes (`oauth2_authorization_code`, `api_key`, etc.) |
| `config.fields[]` | object[] | Configuration field definitions with widget types, validation rules, and defaults |
| `recordTypes` | object \| undefined | Selectable record type definitions |
| `filters` | object \| undefined | Path and label filter capabilities |
| `inference` | object \| undefined | Inference toggle and confidence threshold config |
| `sync` | object \| undefined | Sync delivery methods and polling options |
| `defaultFieldMappings` | Record\<string, Record\<string, string\>\> \| undefined | Default field mappings per record type |

Supported widget types: `text`, `email`, `url`, `secret`, `number`, `textarea`, `select`, `multi-select`, `tag-input`, `checkbox`, `slider`, `key-value`, `secret-file`.

## Example

**Request:**
```http
GET /v1/plugin-schema/github
```

**Response:**
```json
{
  "apiVersion": "oxagen.ai/v1alpha1",
  "kind": "ConnectorPlugin",
  "metadata": {
    "id": "github",
    "displayName": "GitHub",
    "version": "1.3.0",
    "schemaVersion": "1.0.0",
    "publisher": { "name": "Oxagen", "verified": true }
  },
  "auth": {
    "schemes": [
      {
        "id": "oauth2",
        "kind": "oauth2_authorization_code",
        "scopes": ["repo", "read:org"]
      },
      {
        "id": "pat",
        "kind": "api_key",
        "fields": [{ "key": "token", "label": "Personal Access Token", "widget": "secret" }]
      }
    ]
  },
  "config": {
    "fields": [
      {
        "key": "organizations",
        "label": "Organizations",
        "widget": "tag-input",
        "description": "GitHub org names to sync",
        "validation": { "required": true, "minItems": 1 }
      }
    ]
  },
  "recordTypes": {
    "selectionMode": "multi",
    "defaultAll": true,
    "items": [
      { "id": "pull_request", "displayName": "Pull Requests", "defaultEnabled": true },
      { "id": "issue", "displayName": "Issues", "defaultEnabled": true },
      { "id": "commit", "displayName": "Commits", "defaultEnabled": false }
    ]
  }
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Not workspace-scoped — returns the same schema for all callers with sufficient org membership.
- Use this before calling `integration.install` to construct the `config` payload.
- Use alongside `plugin.schema.validate` to validate user input before submission.

## Related
- `plugin.schema.validate` — validate a config object against this schema
- `plugin.version.list` — browse available plugin versions
- `integration.install` — install a plugin instance using this schema
- `plugin.catalog.get` — full catalog entry with marketing metadata
