# secret.value.set

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** no

## Intent

Set a secret's **value override** for a specific environment. A value override is
per `(key, environment)`; when present it wins over the key's default value. The
override is envelope-encrypted or stored as plaintext according to the key's
`sensitive` flag (storage mode is a property of the key, not of the override).
Plaintext is never logged. Owner/Admin only.

## Input

| Field           | Type     | Default  | Notes                                          |
| --------------- | -------- | -------- | ---------------------------------------------- |
| `keyId`         | `string` | required | Public id of the vault key (min 1)             |
| `environmentId` | `string` | required | Public id of the target environment (min 1)    |
| `value`         | `string` | required | Plaintext value to store for this environment  |

## Output

| Field | Type      | Notes                              |
| ----- | --------- | ---------------------------------- |
| `ok`  | `boolean` | `true` when the override was set   |

## Side effects

Inserts or updates the `(key, environment)` override row in the `environments`
vault tables (PostgreSQL). When the key is sensitive, `value` is envelope-encrypted
(`value_enc` + `value_kms_key_id`); otherwise stored as plaintext text. Metering,
IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/secret/value/set
Content-Type: application/json

{
  "keyId": "secret_...",
  "environmentId": "env_...",
  "value": "sk_test_..."
}
```

## MCP

Tool name: `secret.value.set`

## Errors

- `validation_error` — missing/empty `keyId` or `environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — key or environment not found in the active workspace.
