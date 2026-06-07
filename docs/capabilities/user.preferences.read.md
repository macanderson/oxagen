# user.preferences.read

**Domain:** user
**Mode:** sync
**Scope:** user (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the calling user's UI and model preferences. Preferences are per-user (not per-workspace) and include display density, font size, keyboard behaviour, and default model selection. Every authenticated user can read their own preferences regardless of role.

## Input

No fields.

## Output

| Field | Type | Notes |
|---|---|---|
| `fontSize` | `"small" \| "medium" \| "large"` | UI font size preference. |
| `density` | `"compact" \| "comfortable" \| "spacious"` | UI density preference. |
| `enterToSubmit` | `boolean` | Whether Enter submits the chat input (vs Shift+Enter). |
| `pendingPromptBehavior` | `"queue" \| "interrupt"` | How to handle a new prompt while a response is streaming. |
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null` | User's preferred text model tier. `null` = workspace default. |
| `defaultTextModel` | `string \| null` | Specific text model override. `null` = tier default. |
| `defaultImageModel` | `string \| null` | Image model override. `null` = workspace default. |
| `defaultVideoModel` | `string \| null` | Video model override. `null` = workspace default. |

## Roles

All roles (Owner, Admin, Member, Viewer) — org and workspace level.

## Side effects

None — read-only.

## Surfaces

- `GET /api/v1/{org}/{ws}/user/preferences`
- MCP tool `user_preferences_read`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | No authenticated session. |
