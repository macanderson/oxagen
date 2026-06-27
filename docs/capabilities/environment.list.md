# environment.list

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

List the environments configured in the active workspace. Returns the lean
summary shape for each environment, including which one is the default and
whether each is active. Read-only; available to workspace Members and above.

## Input

_None._ The capability is scoped to the caller's active org + workspace from
context; it takes no request fields.

## Output

| Field          | Type                    | Notes                                                       |
| -------------- | ----------------------- | ----------------------------------------------------------- |
| `environments` | `EnvironmentSummary[]`  | Each `{ id, name, slug, description, isDefault, isActive }` |

## Side effects

None — read-only against `environments.environments` (PostgreSQL).

## API

```
POST /v1/{org}/{workspace}/environment/list
Content-Type: application/json

{}
```

## MCP

Tool name: `environment.list`

## Errors

- `unauthorized` — caller lacks workspace Member role or higher.
