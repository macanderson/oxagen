# secret.import_env

**Domain:** secret
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** no

## Intent

Parse pasted `.env` text and, optionally, upsert keys + set values for the
workspace defaults or a chosen environment. Parsing accepts `KEY=VALUE`,
`export KEY=VALUE`, quoted (`KEY="value"` / `KEY='value'`) and empty (`KEY=`)
forms; surrounding quotes are stripped while inner content (including `=`) is
preserved; blank lines and `#` comments are ignored. New keys default to
`sensitive=true`; existing keys keep their flag. The call is **preview-only by
default** (`commit: false`) — it returns the parsed rows and which are new keys vs
overrides so the UI can confirm before an explicit commit. Owner/Admin only.

## Input

| Field           | Type              | Default  | Notes                                                                 |
| --------------- | ----------------- | -------- | --------------------------------------------------------------------- |
| `text`          | `string`          | required | Raw `.env` text to parse                                              |
| `environmentId` | `string \| null?` | `null`   | Omit/`null` targets the workspace **default** values; provide to target an environment's overrides |
| `commit`        | `boolean`         | `false`  | When false, returns a preview only; when true, applies the upserts    |

## Output

| Field       | Type                                                                          | Notes                                              |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `rows`      | `Array<{ key, isNewKey, sensitive, target, willOverride }>`                   | Parsed rows; `target` is `"default" \| "override"` |
| `committed` | `boolean`                                                                     | `true` when the import was actually applied        |

Each `rows[]` entry:

| Field          | Type                       | Notes                                                  |
| -------------- | -------------------------- | ------------------------------------------------------ |
| `key`          | `string`                   | Parsed key name                                        |
| `isNewKey`     | `boolean`                  | Whether the key is created by this import              |
| `sensitive`    | `boolean`                  | Effective sensitive flag (new keys default true)       |
| `target`       | `"default" \| "override"`  | Whether the value writes the default or an env override |
| `willOverride` | `boolean`                  | Whether an existing value would be replaced            |

## Side effects

When `commit: false` — none (pure parse + diff). When `commit: true` — upserts
keys and writes values (default or per-environment overrides) into the
`environments` vault tables (PostgreSQL); sensitive values are envelope-encrypted.
Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/secret/import-env
Content-Type: application/json

{
  "text": "STRIPE_SECRET_KEY=sk_live_...\nexport DATABASE_URL=\"postgres://...\"",
  "environmentId": null,
  "commit": false
}
```

## MCP

Tool name: `secret.import_env`

## Errors

- `validation_error` — input failed Zod parse.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — `environmentId` provided but not found in the active workspace.
