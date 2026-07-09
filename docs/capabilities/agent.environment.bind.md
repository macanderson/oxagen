# bind_agent_environment

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Bind an agent to a workspace environment, and optionally to one specific
sandbox template within it. This is an upsert: calling it again for the same
`(agentId, environmentId)` pair updates the existing binding rather than
creating a duplicate. Promoting a binding to `isPrimary: true` atomically
demotes the agent's previous primary binding, mirroring the
`set_default_sandbox_template` swap pattern. Owner/Admin only.

## Input

| Field               | Type       | Default  | Notes                                                                                             |
| ------------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `agentId`           | `string`    | required | Public id of the agent (min 1)                                                                      |
| `environmentId`     | `string`    | required | Public id of the workspace environment (min 1)                                                      |
| `sandboxTemplateId` | `string \| null?` | unset | Public id of a specific template within the environment; `null` (or omitted) means "resolve to the environment's default template at run time" |
| `isPrimary`         | `boolean?`  | unset    | Promote this binding to the agent's primary environment; atomically demotes the prior primary       |

## Output

| Field     | Type                     | Notes                                                                                                           |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `binding` | `AgentEnvironmentBinding` | `{ id, agentId, environmentId, environmentName, environmentSlug, sandboxTemplateId, sandboxTemplateName, isPrimary }`; a `null` `sandboxTemplateId` means the binding resolves to the environment's default template |

## Side effects

Upserts a row in `environments.agent_environment_bindings` (PostgreSQL),
keyed on `(agentId, environmentId)`. When `isPrimary: true` is set, the
agent's prior primary binding row is demoted in the same transaction.
Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/agent/environment/bind
Content-Type: application/json

{
  "agentId": "agt_...",
  "environmentId": "env_...",
  "sandboxTemplateId": "sbx_...",
  "isPrimary": true
}
```

## MCP

Tool name: `bind_agent_environment`

## Errors

- `validation_error` — missing/empty `agentId`/`environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no agent, environment, or (if supplied) sandbox template with that id in the active workspace.
