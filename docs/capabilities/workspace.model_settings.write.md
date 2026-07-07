# workspace.model.settings.write

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Update the workspace-level model defaults. Partial update — only fields explicitly provided are changed. Nullable-optional fields follow the pattern: omit = no change; `null` = clear the setting (revert to platform default); string = set to a specific model slug. Restricted to Workspace Owner and Admin (Members cannot change workspace defaults).

## Input

All fields are optional. Provide only the fields you want to change.

| Field | Type | Notes |
|---|---|---|
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null?` | Omit = no change; `null` = clear; string = set. |
| `defaultTextModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |
| `defaultImageModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |
| `defaultVideoModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |

## Output

Returns the full, merged workspace model settings after the update.

| Field | Type | Notes |
|---|---|---|
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null` | |
| `defaultTextModel` | `string \| null` | |
| `defaultImageModel` | `string \| null` | |
| `defaultVideoModel` | `string \| null` | |

## Roles

Org Owner, Org Admin. Workspace Owner, Workspace Admin.

## Side effects

- Postgres: upserts workspace model settings row.
- ClickHouse: emits `workspace.model_settings_updated` event.

## Surfaces

- `PATCH /api/v1/{org}/{ws}/workspace/model-settings`
- MCP tool `workspace_model_settings_write`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks Workspace Admin role or higher. |
| `not_found` | Workspace does not exist. |
| `validation_error` | Input failed Zod parse. |
