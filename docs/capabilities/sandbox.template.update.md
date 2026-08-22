# update_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Update a sandbox template's metadata, provider, runtime, resources, network,
secret selection, literal config, packages, or active state. This is a partial update —
only supplied fields change. A default template cannot be deactivated via
`isActive: false`; promote another template to default first via
`set_default_sandbox_template`. Owner/Admin only.

## Input

| Field             | Type                       | Default  | Notes                                                                                       |
| ----------------- | -------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `templateId`      | `string`                   | required | Public id of the sandbox template (min 1)                                                     |
| `name`            | `string?`                  | unchanged | Display name (min 1 char if provided)                                                        |
| `slug`            | `string?`                  | unchanged | URL-safe slug, unique within the workspace                                                   |
| `description`     | `string \| null?`          | unchanged | Human description                                                                            |
| `provider`        | `"modal" \| "vercel" \| "docker"?` | unchanged | Sandbox driver                                                                       |
| `runtime`         | `string \| null?`          | unchanged | Runtime image identifier                                                                      |
| `resources`       | `SandboxResources?`        | unchanged | `{ vcpu?≤4, memoryMb?≤8192, timeoutMs?≤300000, diskMb?≤20480 }`                              |
| `network`         | `SandboxNetwork?`          | unchanged | `{ mode, config? }`                                                                          |
| `secretSelection` | `SandboxSecretSelection?`  | unchanged | `"all"` or `{ keyPublicIds: string[] }`                                                      |
| `literalEnv`      | `Record<string,string>?`  | unchanged | Non-sensitive `KEY=value` config                                                             |
| `packages`        | `SandboxPackageGroup[]?`  | unchanged | Per-ecosystem packages installed at provision time: `{ manager, names }[]`; `manager` ∈ `apt, cargo, gem, go, npm, pnpm, yarn, pip, poetry, uv`; `names` are free-text specs that may carry a version pin. Only replaced when provided |
| `isActive`        | `boolean?`                 | unchanged | Cannot be set to `false` while the template is the environment default                       |

## Output

| Field      | Type                    | Notes                                                                       |
| ---------- | ----------------------- | ----------------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | Updated template, same shape as `get_sandbox_template`                       |

## Side effects

Updates the matching row in `environments.sandbox_templates` (PostgreSQL) —
tools are not touched by this capability; use `set_sandbox_template_tools` to
replace the tool set. Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/update
Content-Type: application/json

{
  "templateId": "sbx_...",
  "resources": { "memoryMb": 8192 },
  "isActive": true
}
```

## MCP

Tool name: `update_sandbox_template`

## Errors

- `validation_error` — input failed Zod parse (empty `name`/`slug`, resource cap exceeded).
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no template with that id in the active workspace.
- `conflict` — `slug` collides with another template, or `isActive: false` was sent for the environment's default template.
