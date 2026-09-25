# reveal_secret

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high
**Requires approval:** no, because the flag applies only on the agent surface

## Intent

Reveal a single secret's **plaintext** value (the environment override if present,
otherwise the key's default) for a given environment. This is the deliberate
difference from write-only secret stores: secrets *are* retrievable in plaintext
by authorized principals — Google-Secret-Manager-style — but **every** reveal is
recorded. Owner/Admin only.

> **Surfaces deliberately exclude the in-chat `agent`.** Revealing plaintext is an
> exfiltration risk, so this capability is reachable only via the API or an MCP
> client holding an API key (a human-configured integration), never the chat agent.

The contract sets `requiresApproval: true`, but only an agent turn reads that
flag, so no approval card opens for an API or MCP call. IAM limits each call to
org Owner or Admin, the workspace's decision rules apply, and every reveal is
recorded in `environments.secret_access_log` and `security_events`.

## Input

| Field           | Type              | Default  | Notes                                                       |
| --------------- | ----------------- | -------- | ----------------------------------------------------------- |
| `keyId`         | `string`          | required | Public id of the vault key (min 1)                          |
| `environmentId` | `string \| null?` | `null`   | Environment to resolve against; `null`/omit uses the default scope |

## Output

| Field    | Type                                | Notes                                                  |
| -------- | ----------------------------------- | ------------------------------------------------------ |
| `key`    | `string`                            | Key name                                               |
| `value`  | `string \| null`                    | Decrypted resolved value; `null` when the secret is unset |
| `source` | `"override" \| "default" \| "unset"`| Where the resolved value came from                     |

## Side effects

**Writes an audit row to `environments.secret_access_log`** (actor, scope, time)
on every call (Spec §7.3). Sensitive values are decrypted in-memory via
`@oxagen/crypto`; plaintext is never logged. Metering, IAM, and audit run through
the kernel.
- **Writes a `secret.revealed` row to `security_events`** as well, so the access is visible to the main audit log query and the audit-log UI, not only to `secret_access_log` (ADR-050).

## API

```
POST /v1/{org}/{workspace}/secret/reveal
Content-Type: application/json

{
  "keyId": "secret_...",
  "environmentId": "env_..."
}
```

## MCP

Tool name: `reveal_secret`

## Errors

- `validation_error` — missing/empty `keyId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — key or environment not found in the active workspace.
