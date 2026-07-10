# update_workspace_user_preferences

**Domain:** user
**Mode:** sync
**Scope:** user + workspace
**Surfaces:** api (app-only)
**Risk level:** low

## Intent

Update the calling user's **per-workspace** coding-agent defaults — partial
update; only fields explicitly provided are changed. This is the **only**
surface allowed to write these defaults: the web app. MCP and agent
surfaces may read the defaults (via
[get_workspace_user_preferences](get_workspace_user_preferences.md)) but
must never silently rewrite a user's default, so this capability is
deliberately `surfaces: ["api"]` only — no MCP tool, no agent tool.

Setting a default repo also lets the caller record the one-time
"set a default repo?" prompt as answered via `markRepoPrompted`, so the app
doesn't re-prompt on every session.

## Input

All fields are optional. Nullable-optional fields follow the pattern: omit =
no change; `null` = clear the default; value = set it.

| Field | Type | Notes |
|---|---|---|
| `defaultRepoConnectionId` | `string \| null` (min 1 char if string) | Repo connection `publicId` to set as default. |
| `defaultRepoSlug` | `string \| null` (min 1 char if string) | Denormalized `owner/repo` slug of the default connection, for display. |
| `defaultEnvironmentId` | `string \| null` (min 1 char if string) | Environment `publicId` to set as default. |
| `markRepoPrompted` | `boolean` (opt.) | When `true`, stamps `repo_default_prompted_at = now()` so the one-time prompt is not shown again. |

## Output

Returns the full, merged state after the update (same shape as
`get_workspace_user_preferences`).

| Field | Type | Notes |
|---|---|---|
| `defaultRepoConnectionId` | `string \| null` | |
| `defaultRepoSlug` | `string \| null` | |
| `defaultEnvironmentId` | `string \| null` | |
| `repoDefaultPrompted` | `boolean` | |

## Roles

All roles (Owner, Admin, Member, Viewer) — org and workspace level. Users can
only update their own per-workspace defaults.

## Side effects

- Postgres: upserts the calling user's row in `workspace_user_preferences` for the current `(userId, workspaceId)`.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | No authenticated session, or caller is not a member of the workspace. |

## Surfaces

- **API:** `POST /v1/{org}/{ws}/user/workspace-preferences`
- **MCP:** not exposed — app-only capability by design (see Intent).
- **Agent:** no approval required, risk `low`, category `user` (declared for consistency; not reachable via the agent tool surface since only `api` is listed).

## Related

- [get_workspace_user_preferences](get_workspace_user_preferences.md) — the read counterpart, exposed on api/mcp/agent.
- [user.preferences.write](user.preferences.write.md) — the per-user (not per-workspace) UI/model preference write.
