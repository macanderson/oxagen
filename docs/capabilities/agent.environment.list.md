# list_agent_environments

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

List an agent's environment bindings, with each binding's resolved sandbox
template name. This is the read path behind the agent's environment/sandbox
configuration panel and is the introspection counterpart to
`bind_agent_environment`/`unbind_agent_environment`. Workspace members can
read.

## Input

| Field     | Type     | Default  | Notes                        |
| --------- | -------- | -------- | ------------------------------ |
| `agentId` | `string` | required | Public id of the agent (min 1) |

## Output

| Field      | Type                        | Notes                                                                                                                        |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bindings` | `AgentEnvironmentBinding[]` | Each: `{ id, agentId, environmentId, environmentName, environmentSlug, sandboxTemplateId, sandboxTemplateName, isPrimary }`; a `null` `sandboxTemplateId`/`sandboxTemplateName` means the binding resolves to the environment's default template |

## Side effects

Read-only. No PostgreSQL rows are written. Metering, IAM, and audit run
through the kernel.

## API

```
POST /v1/{org}/{workspace}/agent/environment/list
Content-Type: application/json

{
  "agentId": "agt_..."
}
```

## MCP

Tool name: `list_agent_environments`

## Errors

- `validation_error` — missing/empty `agentId`.
- `unauthorized` — caller is not a member of the active workspace.
- `not_found` — no agent with that id in the active workspace.
