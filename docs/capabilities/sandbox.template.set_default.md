# set_default_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Promote a sandbox template to its environment's default. The swap is
**atomic** — the existing default within that environment is demoted and the
target is set as the single default in one transaction, mirroring
`environment.set_default`. The promoted template is reactivated if it was
inactive. Owner/Admin only.

## Input

| Field        | Type     | Default  | Notes                              |
| ------------ | -------- | -------- | ------------------------------------ |
| `templateId` | `string` | required | Public id of the template to promote (min 1) |

## Output

| Field      | Type                    | Notes                                                              |
| ---------- | ----------------------- | -------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | Promoted template (`isDefault: true`, `isActive: true`)              |

## Side effects

Atomically updates `is_default` across the environment's rows in
`environments.sandbox_templates` (PostgreSQL). The promoted template is
reactivated. Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/set-default
Content-Type: application/json

{
  "templateId": "sbx_..."
}
```

## MCP

Tool name: `set_default_sandbox_template`

## Errors

- `validation_error` — missing/empty `templateId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no template with that id in the active workspace.
