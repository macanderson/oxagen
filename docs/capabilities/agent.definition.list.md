# agent.definition.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the agent definitions in the current workspace with their identity, lifecycle status, deployment posture, and latest version number. Optionally filter by lifecycle status.

## Input

| Field | Type | Notes |
|---|---|---|
| `status?` | `"draft" \| "active" \| "archived"` | Optional filter by lifecycle status. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agents` | `AgentSummary[]` | The workspace's agent definitions — see fields below. |
| `agents[].agentId` | `string` | Internal UUID. |
| `agents[].publicId` | `string` | Prefixed public identifier (`agt_…`). |
| `agents[].slug` | `string` | Agent slug. |
| `agents[].name` | `string` | Human-readable name. |
| `agents[].description` | `string \| null` | Description or null. |
| `agents[].agentType` | `string` | Type discriminator (`custom`, `interactive_chat`, `code`, …). `code` marks a code agent (repo/code tools + UI); see `isCodeAgentType`. |
| `agents[].status` | `"draft" \| "active" \| "archived"` | Lifecycle status. |
| `agents[].deploymentStatus` | `"inactive" \| "active"` | Deployment posture. |
| `agents[].latestVersion` | `number \| null` | Highest version number, or null when none. |
| `agents[].managed` | `boolean` | True for product-managed built-in agents — read-only to customers. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of workspace agent rows.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
