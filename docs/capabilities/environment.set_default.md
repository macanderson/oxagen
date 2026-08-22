# environment.set_default

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Promote an environment to the workspace default. The swap is **atomic** — the
existing default is demoted and the target is set as the single default in one
transaction (enforced by a partial-unique constraint on `is_default`). The
promoted environment is reactivated if it was inactive. This is the path used by
the `settings/environments` "Default environment" selector and is also exposed
via API/MCP for capability parity. Owner/Admin only.

## Input

| Field           | Type     | Default  | Notes                                            |
| --------------- | -------- | -------- | ------------------------------------------------ |
| `environmentId` | `string` | required | Public id of the environment to promote (min 1)  |

## Output

| Field         | Type                 | Notes                                                       |
| ------------- | -------------------- | ----------------------------------------------------------- |
| `environment` | `EnvironmentSummary` | Promoted environment (`isDefault: true`, `isActive: true`)  |

## Side effects

Atomically updates `is_default` across the workspace's environment rows
(PostgreSQL). The promoted environment is reactivated. Metering, IAM, and audit
run through the kernel.

## API

```
POST /v1/{org}/{workspace}/environment/set-default
Content-Type: application/json

{
  "environmentId": "env_..."
}
```

## MCP

Tool name: `environment.set_default`

## Errors

- `validation_error` — missing/empty `environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no environment with that id in the active workspace.
