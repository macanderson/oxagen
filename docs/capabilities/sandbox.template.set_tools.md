# set_sandbox_template_tools

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Replace the full set of preloaded tools on a sandbox template — replace-set
semantics, mirroring `secret.value.set`/`environment.update` style upserts:
the given `tools` array becomes the template's entire tool set, not a merge.
Pass an empty array to clear all preloaded tools. Owner/Admin only.

Note: the plan's working name was `sandbox.template.tools.set` (a 4-segment
name), which is illegal under ADR-022's `domain.subject.action` convention.
The conforming form folds the compound into the action segment, mirroring the
existing `set_default`/`set_enabled`/`set_secret` precedent.

## Input

| Field        | Type                      | Default  | Notes                                                                                             |
| ------------ | -------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `templateId` | `string`                   | required | Public id of the sandbox template (min 1)                                                            |
| `tools`      | `SandboxTemplateTool[]`   | required | Replace-set. Each entry: `{ kind, ref, config? }`; `kind` ∈ `capability, mcp_server, agent_skill, tool`; `ref` min 1 char |

## Output

| Field      | Type                    | Notes                                                              |
| ---------- | ----------------------- | -------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | Updated template with its new `tools` array, same shape as `get_sandbox_template` |

## Side effects

Replaces every row in `environments.sandbox_template_tools` for the given
template — deletes the prior set and inserts the supplied one within a single
transaction. Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/set-tools
Content-Type: application/json

{
  "templateId": "sbx_...",
  "tools": [
    { "kind": "capability", "ref": "web.search" },
    { "kind": "mcp_server", "ref": "github", "config": { "readOnly": true } }
  ]
}
```

## MCP

Tool name: `set_sandbox_template_tools`

## Errors

- `validation_error` — input failed Zod parse (empty `templateId`/`ref`, duplicate `kind`+`ref` pair).
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no template with that id in the active workspace.
