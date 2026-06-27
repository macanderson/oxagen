# secret.export

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Export the resolved secret set for an environment as decrypted key/value pairs
plus rendered `.env` text. Each key resolves to its environment override if
present, otherwise its default. Like `secret.reveal`, this is the deliberate
reversible-plaintext difference from write-only stores — and like it, **every**
export is recorded. Owner/Admin only.

> **Surfaces deliberately exclude the in-chat `agent`.** Exporting plaintext is an
> exfiltration risk, so this capability is reachable only via the API or an MCP
> client holding an API key, never the chat agent.

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

Tool name: `secret.export`

## Errors

- `validation_error` — input failed Zod parse.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — `environmentId` or a listed key not found in the active workspace.
