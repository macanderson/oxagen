# create_environment

**Domain:** environment
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Create a workspace environment such as `production`, `development`, or
`preview` to scope secret values. Additional environments let the vault hold
per-environment value overrides. A new environment is active and non-default.
Use `set_default_environment` to make it the default. Only org Owners and
Admins can create environments.

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

Tool name: `create_environment`

## Errors

- `validation_error`: input failed Zod parse (empty `name`/`slug`).
- `forbidden` (`org_role_required`): the caller is not an org Owner or Admin.
- `conflict`: an environment with the same `slug` already exists in the workspace.
