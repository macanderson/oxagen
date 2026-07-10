# agent.definition.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the agent definitions in the current workspace with their identity, lifecycle status, deployment posture, latest version number, and a refs-only view of the tools each agent loads. Optionally filter by lifecycle status.

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
| `agents[].slug` | `string` | Agent slug (immutable; new agents capped at 18 chars). |
| `agents[].agentKey` | `string \| null` | Immutable, globally-unique key `org_namespace.workspace_namespace.agent_slug` (e.g. `acme.core.qa-chat`). Resolved once per call from the tenant's namespaces (no N+1). Null only for pre-namespace-backfill scopes. |
| `agents[].name` | `string` | Human-readable name. |
| `agents[].description` | `string \| null` | Description or null. |
| `agents[].agentType` | `string` | Type discriminator (`custom`, `interactive_chat`, `code`, …). `code` marks a code agent (repo/code tools + UI); see `isCodeAgentType`. |
| `agents[].status` | `"draft" \| "active" \| "archived"` | Lifecycle status. |
| `agents[].deploymentStatus` | `"inactive" \| "active"` | Deployment posture. |
| `agents[].latestVersion` | `number \| null` | Highest version number, or null when none. |
| `agents[].managed` | `boolean` | True for product-managed built-in agents — read-only to customers. |
| `agents[].toolRefs` | `{ type, ref }[]` | Refs (type + ref only) of everything the agent loads — functions, MCP servers, skills, subagents — taken from the config of its active version (else latest), matching `agent.definition.get` resolution. Lets the app's agent picker render tool/skill chips without an N+1 of `get_agent_def`. Refs-only by design: never the per-tool config payloads (MCP auth, skill pins, budgets). Empty (`[]`) when the agent loads nothing or its config is absent/malformed. `type` ∈ `"function" \| "mcp_server" \| "skill" \| "agent"`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of workspace agent rows.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
