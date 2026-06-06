# plugin.settings.set_auth_alerts

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Configure re-authentication alert preferences for the org. Controls which roles receive in-app and email notifications when a plugin's OAuth token expires and re-authentication is required.

## Input

| Field | Type | Notes |
|---|---|---|
| `sendEmail` | `boolean` | Whether to send email notifications in addition to in-app alerts. |
| `roles` | `string[]` | Org roles that receive alerts (e.g. `["Owner", "Admin"]`). At least one required. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: upserts `plugin.org_settings` row with alert preferences.
- ClickHouse: emits `plugin.settings.auth_alerts_updated` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/settings/set-auth-alerts`
- MCP tool `plugin_settings_set_auth_alerts`
