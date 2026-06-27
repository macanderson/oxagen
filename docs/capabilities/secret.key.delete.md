# secret.key.delete

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** no

## Intent

Soft-delete a vault secret key and hard-remove all of its per-environment value
overrides. The key's default value and every override are dropped together, so
any sandbox or agent run that resolved this key will fall through to unset.
Owner/Admin only.

## Input

| Field   | Type     | Default  | Notes                          |
| ------- | -------- | -------- | ------------------------------ |
| `keyId` | `string` | required | Public id of the key (min 1)   |

## Output

| Field | Type      | Notes                            |
| ----- | --------- | -------------------------------- |
| `ok`  | `boolean` | `true` when the key was deleted  |

## Side effects

Soft-deletes the key row and hard-deletes every per-environment override row in
the `environments` vault tables (PostgreSQL). Metering, IAM, and audit run
through the kernel.

## API

```
POST /v1/{org}/{workspace}/secret/key/delete
Content-Type: application/json

{
  "keyId": "secret_..."
}
```

## MCP

Tool name: `secret.key.delete`

## Errors

- `validation_error` — missing/empty `keyId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no key with that id in the active workspace vault.
