# environment.get

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Fetch a single workspace environment by its public id. Returns the same lean
summary shape as `environment.list`. Read-only; available to workspace Members
and above.

## Input

| Field           | Type     | Default  | Notes                                  |
| --------------- | -------- | -------- | -------------------------------------- |
| `environmentId` | `string` | required | Public id of the environment (min 1)   |

## Output

| Field         | Type                 | Notes                                                 |
| ------------- | -------------------- | ----------------------------------------------------- |
| `environment` | `EnvironmentSummary` | `{ id, name, slug, description, isDefault, isActive }` |

## Side effects

None — read-only against `environments.environments` (PostgreSQL).

## API

```
POST /v1/{org}/{workspace}/environment/get
Content-Type: application/json

{
  "environmentId": "env_..."
}
```

## MCP

Tool name: `environment.get`

## Errors

- `validation_error` — missing/empty `environmentId`.
- `unauthorized` — caller lacks workspace Member role or higher.
- `not_found` — no environment with that id in the active workspace.
