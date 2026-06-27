# environment.delete

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Soft-delete a workspace environment. The **default environment cannot be
deleted** — the call is rejected with an error instructing the caller to promote
another environment first via `environment.set_default`. Owner/Admin only.

## Input

| Field           | Type     | Default  | Notes                                  |
| --------------- | -------- | -------- | -------------------------------------- |
| `environmentId` | `string` | required | Public id of the environment (min 1)   |

## Output

| Field | Type      | Notes                                  |
| ----- | --------- | -------------------------------------- |
| `ok`  | `boolean` | `true` when the environment was deleted |

## Side effects

Soft-deletes the `environments.environments` row (PostgreSQL). Per-environment
secret value overrides bound to it are removed. Metering, IAM, and audit run
through the kernel.

## API

```
POST /v1/{org}/{workspace}/environment/delete
Content-Type: application/json

{
  "environmentId": "env_..."
}
```

## MCP

Tool name: `environment.delete`

## Errors

- `validation_error` — missing/empty `environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no environment with that id in the active workspace.
- `conflict` — the target environment is the current default; promote another first.
