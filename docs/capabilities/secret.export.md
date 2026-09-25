# export_secrets

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high
**Requires approval:** no, because the flag applies only on the agent surface

## Intent

Export the resolved secret set for an environment as decrypted key/value pairs
plus rendered `.env` text. Each key resolves to its environment override if
present, otherwise its default. Like `secret.reveal`, this is the deliberate
reversible-plaintext difference from write-only stores — and like it, **every**
export is recorded. Owner/Admin only.

> **Surfaces deliberately exclude the in-chat `agent`.** Exporting plaintext is an
> exfiltration risk, so this capability is reachable only via the API or an MCP
> client holding an API key, never the chat agent.

The contract sets `requiresApproval: true`, but only an agent turn reads that
flag, so no approval card opens for an API or MCP call. IAM limits each call to
org Owner or Admin, the workspace's decision rules apply, and every export is
recorded in `environments.secret_access_log` and `security_events`.

## Input

| Field           | Type                  | Default  | Notes                                                          |
| --------------- | --------------------- | -------- | -------------------------------------------------------------- |
| `environmentId` | `string \| null?`     | `null`   | Environment to resolve against; `null`/omit uses the default scope |
| `keyIds`        | `string[] \| null?`   | `null`   | Restrict to specific keys; `null`/omit exports all keys        |

## Output

| Field    | Type                               | Notes                                              |
| -------- | ---------------------------------- | -------------------------------------------------- |
| `env`    | `Array<{ key: string, value: string }>` | Decrypted resolved key/value pairs            |
| `dotenv` | `string`                           | The same set rendered as `.env` text               |

## Side effects

**Writes an audit row to `environments.secret_access_log`** (actor, scope, time)
on every call (Spec §7.3). Sensitive values are decrypted in-memory via
`@oxagen/crypto`; plaintext is never logged. Metering, IAM, and audit run through
the kernel.
- **Writes a `secret.exported` row to `security_events`** as well, so the access is visible to the main audit log query and the audit-log UI, not only to `secret_access_log` (ADR-050).

## API

```
POST /v1/{org}/{workspace}/secret/export
Content-Type: application/json

{
  "environmentId": "env_...",
  "keyIds": null
}
```

## MCP

Tool name: `export_secrets`

## Errors

- `validation_error` — input failed Zod parse.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — `environmentId` or a listed key not found in the active workspace.
