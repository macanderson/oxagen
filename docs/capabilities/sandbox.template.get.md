# sandbox.template.get

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Fetch a single sandbox template, including its full preloaded tool set, by
public id. Used by the template detail/edit view and by any caller that needs
a template's full config (provider, runtime, resources, network,
secretSelection, literalEnv) before invoking `sandbox.template.update` or
`sandbox.template.export`. Workspace members can read.

## Input

| Field        | Type     | Default  | Notes                             |
| ------------ | -------- | -------- | ---------------------------------- |
| `templateId` | `string` | required | Public id of the sandbox template (min 1) |

## Output

| Field      | Type                    | Notes                                                                                                                                                                          |
| ---------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | `{ id, environmentId, name, slug, description, isDefault, isActive, provider, runtime, resources, network, secretSelection, literalEnv, tools }`; `tools` is `{ id, kind, ref, config }[]` |

## Side effects

Read-only. No PostgreSQL rows are written. Metering, IAM, and audit run
through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/get
Content-Type: application/json

{
  "templateId": "sbx_..."
}
```

## MCP

Tool name: `sandbox.template.get`

## Errors

- `validation_error` — missing/empty `templateId`.
- `unauthorized` — caller is not a member of the active workspace.
- `not_found` — no template with that id in the active workspace.
