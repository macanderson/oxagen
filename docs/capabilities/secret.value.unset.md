# secret.value.unset

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Remove a secret's per-environment override so the key falls back to its default
value for that environment. If the key has no default either, the secret resolves
to unset for that environment. The key itself and its other environments'
overrides are unaffected. Owner/Admin only.

## Input

| Field           | Type     | Default  | Notes                                        |
| --------------- | -------- | -------- | -------------------------------------------- |
| `keyId`         | `string` | required | Public id of the vault key (min 1)           |
| `environmentId` | `string` | required | Public id of the environment to clear (min 1) |

## Output

| Field | Type      | Notes                                |
| ----- | --------- | ------------------------------------ |
| `ok`  | `boolean` | `true` when the override was removed |

## Side effects

Hard-deletes the `(key, environment)` override row in the `environments` vault
tables (PostgreSQL). Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/secret/value/unset
Content-Type: application/json

{
  "keyId": "secret_...",
  "environmentId": "env_..."
}
```

## MCP

Tool name: `secret.value.unset`

## Errors

- `validation_error` — missing/empty `keyId` or `environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — key or environment not found in the active workspace.
