# agent.definition.update

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update an agent definition by snapshotting a NEW unpublished version with the updated config. Published versions are immutable and never edited in place; the version number is bumped for each update.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |
| `name?` | `string` (min 1) | Optional new name. |
| `description?` | `string` | Optional new description. |
| `config` | `object` | Versioned body — see below. |
| `config.graph` | `GraphAccess` | Ontology binding, retrieval strategy, and traversal budget. |
| `config.agentTools` | `AgentTool[]` | Loaded functions, MCP servers, skills, subagents. Default `[]`. |
| `config.instructions` | `string?` | Optional system prompt baked into the definition. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Echoes the target agent id. |
| `version` | `number` (positive int) | The newly snapshotted version number. |
| `isPublished` | `boolean` | Always `false` — the new version is unpublished until published. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: inserts a new unpublished `agent_versions` snapshot; updates identity columns (`name`, `description`) on the `agents` row when supplied.
- ClickHouse: emits an `agent.definition.updated` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `not_found` | No agent matches `agentId` in this workspace. |
| `validation_error` | Input failed Zod parse (e.g. invalid config). |
| `unauthorized` | Caller lacks the required org/workspace role. |
