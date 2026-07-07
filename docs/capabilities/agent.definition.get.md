# agent.definition.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Fetch a single agent definition together with its active (or, if none is published, latest) version config. The config is parsed and validated via `parseAgentDefinitionConfig` before it is returned.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Internal UUID. |
| `publicId` | `string` | Prefixed public identifier (`agt_…`). |
| `slug` | `string` | Agent slug (immutable; new agents capped at 18 chars). |
| `agentKey` | `string \| null` | Immutable, globally-unique key `org_namespace.workspace_namespace.agent_slug` (e.g. `acme.core.qa-chat`). Null only for pre-namespace-backfill scopes. Segments are immutable; the 32-char budget is 6 + 1 + 6 + 1 + 18. |
| `name` | `string` | Human-readable name. |
| `description` | `string \| null` | Description or null. |
| `agentType` | `string` | Kind of agent. |
| `status` | `"draft" \| "active" \| "archived"` | Lifecycle status. |
| `deploymentStatus` | `"inactive" \| "active"` | Deployment posture. |
| `version` | `number \| null` | Resolved version number, or null when none. |
| `isPublished` | `boolean` | Whether the resolved version is published. |
| `managed` | `boolean` | True for product-managed built-in agents — viewable but read-only to customers. |
| `config` | `AgentDefinitionConfig` | Parsed graph access, tools, triggers, and instructions. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of the agent identity row and its version config.

## Errors

| code | meaning |
|---|---|
| `not_found` | No agent matches `agentId` in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
