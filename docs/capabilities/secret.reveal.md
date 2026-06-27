# secret.reveal

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Reveal a single secret's **plaintext** value (the environment override if present,
otherwise the key's default) for a given environment. This is the deliberate
difference from write-only secret stores: secrets *are* retrievable in plaintext
by authorized principals — Google-Secret-Manager-style — but **every** reveal is
recorded. Owner/Admin only.

> **Surfaces deliberately exclude the in-chat `agent`.** Revealing plaintext is an
> exfiltration risk, so this capability is reachable only via the API or an MCP
> client holding an API key (a human-configured integration), never the chat agent.

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

Tool name: `secret.reveal`

## Errors

- `validation_error` — missing/empty `keyId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — key or environment not found in the active workspace.
