# secret.key.list

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

List vault secret keys for the workspace with **masked metadata** only. Each row
reports the key name, its `sensitive` flag, memo, whether it has a default value,
and which environments override it — but **never** the plaintext value. To read a
value, use the audited `secret.reveal` / `secret.export` capabilities. Available
to workspace Members and above.

## Input

_None._ The capability is scoped to the caller's active org + workspace from
context; it takes no request fields.

## Output

| Field  | Type                  | Notes                                                                                  |
| ------ | --------------------- | -------------------------------------------------------------------------------------- |
| `keys` | `SecretKeySummary[]`  | Each `{ id, key, sensitive, memo, hasDefault, overrideEnvironmentIds }` — never a value |

`SecretKeySummary` fields:

| Field                   | Type       | Notes                                                  |
| ----------------------- | ---------- | ------------------------------------------------------ |
| `id`                    | `string`   | Public id of the key                                   |
| `key`                   | `string`   | Key name                                               |
| `sensitive`            | `boolean`  | Whether values are encrypted at rest                   |
| `memo`                  | `string \| null` | Optional human note                              |
| `hasDefault`            | `boolean`  | Whether a default value is set                         |
| `overrideEnvironmentIds`| `string[]` | Ids of environments that override this key             |

## Side effects

None — read-only against the `environments` vault tables (PostgreSQL).

## API

```
POST /v1/{org}/{workspace}/secret/key/list
Content-Type: application/json

{}
```

## MCP

Tool name: `secret.key.list`

## Errors

- `unauthorized` — caller lacks workspace Member role or higher.
