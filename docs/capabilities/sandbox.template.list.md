# list_sandbox_templates

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

List sandbox templates in the active workspace, optionally filtered to one
environment. This is the read path behind the `settings/environments` template
picker and the source list for `bind_agent_environment`. Workspace members can
read; only Owner/Admin can mutate templates.

## Input

| Field           | Type              | Default  | Notes                                                        |
| --------------- | ----------------- | -------- | ------------------------------------------------------------- |
| `environmentId` | `string?`         | unset    | Public id of an environment; when set, restricts the list to templates in that environment |

## Output

| Field       | Type                     | Notes                                     |
| ----------- | ------------------------ | ------------------------------------------ |
| `templates` | `SandboxTemplateSummary[]` | Same shape as `get_sandbox_template`; unfiltered when `environmentId` is omitted, scoped to the workspace's environments |

## Side effects

Read-only. No PostgreSQL rows are written. Metering, IAM, and audit run
through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/list
Content-Type: application/json

{
  "environmentId": "env_..."
}
```

## MCP

Tool name: `list_sandbox_templates`

## Errors

- `validation_error` — `environmentId` present but empty.
- `unauthorized` — caller is not a member of the active workspace.
