# environment.create

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Create a workspace environment (e.g. `production`, `development`, `preview`)
for scoping secrets and sandbox config. Each workspace is seeded with a default
environment at creation; additional environments let the vault hold per-environment
value overrides and let sandboxes resolve to environment-specific config. A newly
created environment is active but is **not** the default — promote it explicitly
via `environment.set_default`. Owner/Admin only.

## Input

| Field         | Type              | Default  | Notes                                          |
| ------------- | ----------------- | -------- | ---------------------------------------------- |
| `name`        | `string`          | required | Display name (min 1 char)                      |
| `slug`        | `string`          | required | URL-safe slug, unique within the workspace     |
| `description` | `string \| null?` | `null`   | Optional human description                     |

## Output

| Field         | Type                | Notes                                                         |
| ------------- | ------------------- | ------------------------------------------------------------- |
| `environment` | `EnvironmentSummary` | `{ id, name, slug, description, isDefault, isActive }`        |

## Side effects

Inserts a row into `environments.environments` (PostgreSQL). The new environment
is active and non-default. Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/environment/create
Content-Type: application/json

{
  "name": "Production",
  "slug": "production",
  "description": "Live customer-facing environment"
}
```

## MCP

Tool name: `environment.create`

## Errors

- `validation_error` — input failed Zod parse (empty `name`/`slug`).
- `unauthorized` — caller is not org Owner/Admin.
- `conflict` — an environment with the same `slug` already exists in the workspace.
