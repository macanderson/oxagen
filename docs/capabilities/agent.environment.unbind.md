# unbind_agent_environment

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Remove an agent's binding to an environment. When the removed binding was the
agent's primary, resolution falls back to the workspace's default
environment and that environment's default sandbox template — an agent is
never left with no resolvable environment. Owner/Admin only.

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
(PostgreSQL). If the deleted binding was primary, no replacement row is
written — resolution falls back at read time to the workspace default
environment and its default template. Metering, IAM, and audit run through
the kernel.

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

- `validation_error` — missing/empty `agentId`/`environmentId`.
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no binding exists for that `(agentId, environmentId)` pair.
