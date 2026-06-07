# user.preferences.write

**Domain:** user
**Mode:** sync
**Scope:** user (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Update the calling user's UI and model preferences. Partial update — only fields explicitly provided are changed; omitted fields are left at their current values. Nullable-optional fields follow the pattern: omit = no change; `null` = clear the preference (revert to workspace/tier default); string = set to a specific value.

## Input

All fields are optional. Provide only the fields you want to change.

| Field | Type | Notes |
|---|---|---|
| `fontSize` | `"small" \| "medium" \| "large"?` | UI font size. |
| `density` | `"compact" \| "comfortable" \| "spacious"?` | UI density. |
| `enterToSubmit` | `boolean?` | Whether Enter submits the chat input. |
| `pendingPromptBehavior` | `"queue" \| "interrupt"?` | Behaviour while a response is streaming. |
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null?` | Omit = no change; `null` = clear; string = set. |
| `defaultTextModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |
| `defaultImageModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |
| `defaultVideoModel` | `string \| null?` (1+ chars if string) | Omit = no change; `null` = clear; string = set. |

## Output

Returns the full, merged preferences state after the update (same shape as `user.preferences.read`).

| Field | Type | Notes |
|---|---|---|
| `fontSize` | `"small" \| "medium" \| "large"` | |
| `density` | `"compact" \| "comfortable" \| "spacious"` | |
| `enterToSubmit` | `boolean` | |
| `pendingPromptBehavior` | `"queue" \| "interrupt"` | |
| `defaultTextTier` | `"fast" \| "balanced" \| "precise" \| null` | |
| `defaultTextModel` | `string \| null` | |
| `defaultImageModel` | `string \| null` | |
| `defaultVideoModel` | `string \| null` | |

## Roles

All roles (Owner, Admin, Member, Viewer) — org and workspace level. Users can only update their own preferences.

## Side effects

- Postgres: upserts `users.preferences` (or equivalent preferences column/table) for the calling user.

## Surfaces

- `PATCH /api/v1/{org}/{ws}/user/preferences`
- MCP tool `user_preferences_write`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | No authenticated session. |
| `validation_error` | Input failed Zod parse. |
