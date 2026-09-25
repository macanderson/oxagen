# delete_secret_key

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes, on the agent surface (riskLevel: high)

## Intent

Soft-delete a vault secret key and hard-remove all of its per-environment value
overrides. The key's default value and every override are dropped together, so
subsequent secret resolution cannot return this key.
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
- **Writes a `secret.key_deleted` row to `security_events`**. Before ADR-050 this action left no audit trail anywhere.

## Approval

When an agent turn calls this capability on the `agent` surface, the call waits
for a person to approve it before it runs (`requiresApproval: true`). The in-app
assistant parks the call and the key stays in place until the approved call
resumes.

The `api` and `mcp` surfaces do not read `requiresApproval`. IAM (org Owner or
Admin) and the workspace's decision rules gate those calls.

## API

```
POST /v1/{org}/{workspace}/secret/key/delete
Content-Type: application/json

{
  "keyId": "secret_..."
}
```

## MCP

Tool name: `delete_secret_key`

## Errors

- `validation_error` — missing/empty `keyId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no key with that id in the active workspace vault.
