# unset_secret_value

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes, on the agent surface (riskLevel: high)

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
- **Writes a `secret.value_changed` row to `security_events`** (`capability: unset_secret_value`). The capability field is what tells an unset from a set in a query (ADR-050).

## Approval

When an agent turn calls this capability on the `agent` surface, the call waits
for a person to approve it before it runs (`requiresApproval: true`). It is
rated high, like `set_secret_value`, because removing an override changes the
value the environment resolves. The in-app assistant parks the call and the
override stays in place until the approved call resumes.

The `api` and `mcp` surfaces do not read `requiresApproval`. IAM (org Owner or
Admin) and the workspace's decision rules gate those calls.

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

Tool name: `unset_secret_value`

## Errors

- `validation_error` — missing/empty `keyId` or `environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — key or environment not found in the active workspace.
