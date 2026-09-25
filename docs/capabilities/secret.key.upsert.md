# upsert_secret_key

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes, on the agent surface (riskLevel: high)

## Intent

Create or update a vault secret **key** at the workspace root. A key carries a
`key` name, a `sensitive` flag (default **true**), an optional `memo`, and an
optional **default value** that applies whenever an environment has no override.
`sensitive` is a property of the key and governs storage for *both* the default
and every per-environment override: sensitive values are envelope-encrypted via
`@oxagen/crypto` (`workspace_vault_v1`), non-sensitive values are stored as
plaintext config. Plaintext is never logged or returned by this capability.
Owner/Admin only.

## Input

| Field          | Type              | Default  | Notes                                                                 |
| -------------- | ----------------- | -------- | --------------------------------------------------------------------- |
| `key`          | `string`          | required | Key name (min 1 char), unique within the workspace vault              |
| `sensitive`    | `boolean`         | `true`   | When true, default + overrides are envelope-encrypted                 |
| `memo`         | `string \| null?` | unchanged | Optional human note                                                   |
| `defaultValue` | `string \| null?` | unchanged | `undefined` leaves the default unchanged; `null` clears it; string sets it |

## Output

| Field | Type     | Notes                            |
| ----- | -------- | -------------------------------- |
| `id`  | `string` | Public id of the upserted key    |

## Side effects

Inserts or updates the key row in `environments` vault tables (PostgreSQL). When
`defaultValue` is set and `sensitive` is true, the value is envelope-encrypted
(`value_enc` + `value_kms_key_id`); otherwise it is stored as plaintext text.
Metering, IAM, and audit run through the kernel.
- **Writes a `secret.value_changed` row to `security_events`** (`capability: upsert_secret_key`). Upsert accepts a `defaultValue`, so it can write secret material (ADR-050).

## Approval

When an agent turn calls this capability on the `agent` surface, the call waits
for a person to approve it before it runs (`requiresApproval: true`). When the
in-app assistant parks the call, the approval row keeps only a digest of the
input. The input, `defaultValue` included, is stored encrypted until the
approved call resumes.

The `api` and `mcp` surfaces do not read `requiresApproval`. IAM (org Owner or
Admin) and the workspace's decision rules gate those calls.

## API

```
POST /v1/{org}/{workspace}/secret/key/upsert
Content-Type: application/json

{
  "key": "STRIPE_SECRET_KEY",
  "sensitive": true,
  "memo": "Live mode",
  "defaultValue": "sk_live_..."
}
```

## MCP

Tool name: `upsert_secret_key`

## Errors

- `validation_error` — empty `key`.
- `unauthorized` — caller is not org Owner/Admin.
