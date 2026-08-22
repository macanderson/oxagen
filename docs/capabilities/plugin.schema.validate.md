# plugin.schema.validate

Validate a connector plugin config object against its schema before install or configure. Returns field-level errors for form display.

## Mode
**sync**

## Surfaces
- API: `POST /v1/plugin-schema/:pluginId/validate`
- MCP: `plugin.schema.validate`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pluginId` | string | yes | Connector plugin identifier (e.g., `github`, `google-drive`) |
| `authSchemeId` | string | no | Auth scheme being used (e.g., `oauth2`, `pat`). Required when the plugin has multiple auth schemes. |
| `config` | Record\<string, unknown\> | yes | Config values keyed by field key |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `valid` | boolean | `true` when all fields pass validation |
| `errors` | object[] | Field-level validation errors; empty array when `valid` is `true` |
| `errors[].field` | string | Dot-path to the invalid field (e.g., `config.organizations`) |
| `errors[].message` | string | Human-readable error message |
| `errors[].code` | string | Machine-readable rule that failed: `required`, `min`, `max`, `minItems`, `maxItems`, `pattern`, `itemPattern`, `oneOf`, `type`, `unknown` |

## Example

**Request:**
```http
POST /v1/plugin-schema/github/validate
Content-Type: application/json

{
  "authSchemeId": "pat",
  "config": {
    "organizations": []
  }
}
```

**Response:**
```json
{
  "valid": false,
  "errors": [
    {
      "field": "config.organizations",
      "message": "At least 1 organization is required",
      "code": "minItems"
    }
  ]
}
```

**Successful validation response:**
```json
{
  "valid": true,
  "errors": []
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Not workspace-scoped — uses the same schema for all callers.
- Designed for real-time form validation; call on field blur or before form submission.
- Does not perform network connectivity checks (e.g., verifying an API key is valid); validates shape only.

## Related
- `plugin.schema.get` — fetch the schema definition
- `integration.install` — install the plugin after validation passes
- `integration.configure` — update config (validate before submitting)
