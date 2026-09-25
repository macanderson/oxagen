# unbind_agent_environment

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Remove an agent's binding to an environment. Only org Owners and Admins can
remove bindings. The operation does not select a replacement primary binding.

## Input

| Field           | Type     | Default  | Notes                                     |
| --------------- | -------- | -------- | ------------------------------------------- |
| `agentId`       | `string` | required | Public id of the agent (min 1)              |
| `environmentId` | `string` | required | Public id of the environment to unbind (min 1) |

## Output

| Field | Type      | Notes                          |
| ----- | --------- | -------------------------------- |
| `ok`  | `boolean` | `true` on successful unbind       |

## Side effects

Deletes the matching row from `environments.agent_environment_bindings`
(PostgreSQL). Metering, IAM, and audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/agent/environment/unbind
Content-Type: application/json

{
  "agentId": "agt_...",
  "environmentId": "env_..."
}
```

## MCP

Tool name: `unbind_agent_environment`


## Errors

- `validation_error`: missing/empty `agentId`/`environmentId`.
- `forbidden` (`org_role_required`): the caller is not an org Owner or Admin.
- `not_found`: no agent or environment with that id exists in the active workspace.
