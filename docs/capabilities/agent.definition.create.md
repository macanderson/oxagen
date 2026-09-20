# create_agent_def

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Create a new agent definition. Inserts the agent identity row as a draft in the `inactive` deployment posture, plus an immutable v1 version snapshot carrying the supplied, schema-validated config: graph access, tools, and instructions.

## Input

| Field | Type | Notes |
|---|---|---|
| `slug` | `string` (max 18) | Lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`). |
| `name` | `string` (min 1) | Human-readable name. |
| `description` | `string?` | Optional description of what the agent does. |
| `avatarUrl` | `string?` | HTTPS avatar URL or a designed-avatar specification accepted by `avatarUrlSchema`. |
| `agentType` | `string` | Kind of agent. Default `"custom"`. |
| `config` | `object` | Versioned body. See below. |
| `config.graph` | `GraphAccess` | Ontology binding, retrieval strategy, and traversal budget. |
| `config.agentTools` | `AgentTool[]` | Platform functions and MCP servers. Default `[]`. |
| `config.instructions` | `string?` | Optional system prompt baked into the definition. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Internal UUID of the created agent. |
| `publicId` | `string` | Prefixed public identifier (`agt_` prefix). |
| `slug` | `string` | The slug provided on creation. |
| `version` | `number` (positive int) | Version number of the seeded snapshot (`1`). |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: inserts an `agents` identity row (draft, inactive) and an immutable `agent_versions` v1 snapshot with the validated config.
- ClickHouse: emits an `agent.definition.created` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. bad slug, invalid config). |
| `unauthorized` | Caller lacks the required org/workspace role. |
| `conflict` | An agent with the same slug already exists in the workspace. |

The graph read budget requires a literal final `LIMIT` in each `UNION` branch, including branches inside subqueries. A limit on a different branch, an intermediate `WITH`, or a nested query does not satisfy that requirement. Graph access in `extend` mode retains hop and timeout budgets, but does not append a read-result `LIMIT` to writes.
