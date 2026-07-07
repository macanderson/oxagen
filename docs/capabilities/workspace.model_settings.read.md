# workspace.model.settings.read

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace-level model defaults. These settings govern which text tier, text model, image model, and video model are used when a user has no personal override. All workspace members (including Viewers) can read these settings.

## Input

No fields.

## Output

| Field | Type | Notes |
|---|---|---|
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null` | Workspace default text tier. `null` = platform default. |
| `defaultTextModel` | `string \| null` | Specific text model override. `null` = tier default. |
| `defaultImageModel` | `string \| null` | Image model override. `null` = platform default. |
| `defaultVideoModel` | `string \| null` | Video model override. `null` = platform default. |

## Roles

Org Owner, Org Admin. Workspace Owner, Admin, Member (read access; Viewer is excluded).

## Side effects

None — read-only.

## Surfaces

- `GET /api/v1/{org}/{ws}/workspace/model-settings`
- MCP tool `workspace_model_settings_read`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks workspace Member role or higher. |
| `not_found` | Workspace does not exist. |
