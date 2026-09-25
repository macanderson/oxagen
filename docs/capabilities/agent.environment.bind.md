# bind_agent_environment

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Bind an agent identity to a workspace environment, a named vault of secrets.
Calling again for the same `(agentId, environmentId)` pair updates the binding.
Setting `isPrimary: true` demotes the previous primary binding in the same
transaction. Only org Owners and Admins can write bindings.

## Input

| Field               | Type       | Default  | Notes                                                                                             |
| ------------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `agentId`           | `string`    | required | Public id of the agent (min 1)                                                                      |
| `environmentId`     | `string`    | required | Public id of the workspace environment (min 1)                                                      |
| `isPrimary`         | `boolean?`  | unset    | Promote this binding to the agent's primary environment; atomically demotes the prior primary       |

## Output

| Field     | Type                     | Notes                                                                                                           |
| --------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `binding` | `AgentEnvironmentBinding` | `{ id, agentId, environmentId, environmentName, environmentSlug, isPrimary }` |

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
  "isPrimary": true
}
```

## MCP

Tool name: `bind_agent_environment`


## Errors

- `validation_error`: missing/empty `agentId`/`environmentId`.
- `forbidden` (`org_role_required`): the caller is not an org Owner or Admin.
- `not_found`: no agent or environment with that id in the active workspace.
