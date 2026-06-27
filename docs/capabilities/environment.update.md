# environment.update

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Update a workspace environment's name, slug, description, or active state.
All fields are optional — only the provided ones are written. The **default
environment cannot be deactivated** (`isActive: false` is rejected for the
current default); promote another environment first via `environment.set_default`.
Deactivating an environment stops new runs from resolving to it while in-flight
runs finish. Owner/Admin only.

## Input

| Field           | Type              | Default   | Notes                                                  |
| --------------- | ----------------- | --------- | ------------------------------------------------------ |
| `environmentId` | `string`          | required  | Public id of the environment to update (min 1)         |
| `name`          | `string?`         | unchanged | New display name (min 1 when present)                  |
| `slug`          | `string?`         | unchanged | New URL-safe slug (min 1 when present)                 |
| `description`   | `string \| null?` | unchanged | New description; `null` clears it                      |
| `isActive`      | `boolean?`        | unchanged | Activate/deactivate; cannot deactivate the default     |

## Output

| Field         | Type                 | Notes                                                 |
| ------------- | -------------------- | ----------------------------------------------------- |
| `environment` | `EnvironmentSummary` | Updated `{ id, name, slug, description, isDefault, isActive }` |

## Side effects

Updates the `environments.environments` row (PostgreSQL). Metering, IAM, and
audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/environment/update
Content-Type: application/json

{
  "environmentId": "env_...",
  "description": "Staging — pre-production validation",
  "isActive": true
}
```

## MCP

Tool name: `environment.update`

## Errors

- `validation_error` — bad input (e.g. empty `name`/`slug`).
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no environment with that id in the active workspace.
- `conflict` — new `slug` collides with another environment, or attempting to
  deactivate the current default environment.
