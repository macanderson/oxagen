# delete_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Soft-delete a sandbox template. A default template cannot be deleted —
promote another template in the same environment first via
`set_default_sandbox_template`. Any `bind_agent_environment` rows that
explicitly pinned this template fall back to resolving the environment's
default template at run time. Owner/Admin only.

## Input

| Field        | Type     | Default  | Notes                             |
| ------------ | -------- | -------- | ---------------------------------- |
| `templateId` | `string` | required | Public id of the sandbox template (min 1) |

## Output

| Field | Type      | Notes                        |
| ----- | --------- | ------------------------------ |
| `ok`  | `boolean` | `true` on successful soft-delete |

## Side effects

Soft-deletes the matching row in `environments.sandbox_templates`
(PostgreSQL). Preloaded tool rows in `environments.sandbox_template_tools` are
retained for audit but no longer resolve. Metering, IAM, and audit run through
the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/delete
Content-Type: application/json

{
  "templateId": "sbx_..."
}
```

## MCP

Tool name: `delete_sandbox_template`

## Errors

- `validation_error` — missing/empty `templateId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no template with that id in the active workspace.
- `conflict` — the template is the environment's current default.
