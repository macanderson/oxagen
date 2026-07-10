# get_workspace_user_preferences

**Domain:** user
**Mode:** sync
**Scope:** user + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the calling user's **per-workspace** coding-agent defaults: their
preferred default repository (connection id plus the resolved owner/repo
slug for display), default environment, default agent, and whether the
one-time "set a default repo?" prompt has already been shown. Unlike
[user.preferences.read](user.preferences.read.md) (per-user, UI/model
prefs), this is scoped to `(user, workspace)` — each workspace a user
belongs to carries its own default repo/environment/agent.

Readable by every workspace member (not just admins) so the app can
pre-select the user's default repo/environment/agent in the coding-agent UI
and decide whether to surface the first-time prompt.

## Input

No fields.

## Output

| Field | Type | Notes |
|---|---|---|
| `defaultRepoConnectionId` | `string \| null` | Preferred default repo connection `publicId` (`con_…`); `null` = no default set. |
| `defaultRepoSlug` | `string \| null` | Denormalized `owner/repo` slug of the default connection, for display; `null` when unset. |
| `defaultEnvironmentId` | `string \| null` | Preferred default environment `publicId` (`env_…`); `null` = use the workspace default. |
| `defaultAgentId` | `string \| null` | Preferred default agent `publicId` (`agt_…`); `null` = no default → the app uses its built-in selection. |
| `repoDefaultPrompted` | `boolean` | Whether the one-time repo-default prompt has been shown/answered. `false` = never prompted — the app should offer it on first repo-selector open. |

## Roles

All roles (Owner, Admin, Member, Viewer) — org and workspace level.

## Side effects

None — read-only.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | No authenticated session, or caller is not a member of the workspace. |

## Surfaces

- **API:** `GET /v1/{org}/{ws}/user/workspace-preferences`
- **MCP:** tool defined in `apps/mcp/src/tools/user.workspace_preferences.read.ts`
- **Agent:** no approval required, risk `low`, category `user`.

## Related

- [update_workspace_user_preferences](update_workspace_user_preferences.md) — the app-only write counterpart.
- [user.preferences.read](user.preferences.read.md) / [user.preferences.write](user.preferences.write.md) — the per-user (not per-workspace) UI/model preference pair.
