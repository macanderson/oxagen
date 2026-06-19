# agent.mcp.delete

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high

## Intent

Soft-delete a registered external MCP server. Its tools stop registering
immediately, but tool-descriptor snapshots are retained for at least 365
days for replay durability before a retention job purges them. The change
is audited.

## Input

| Field         | Type      | Notes                                       |
| ------------- | --------- | ------------------------------------------- |
| `mcpServerId` | `string`  | ID of the registered external MCP server.   |

## Output

| Field         | Type      | Notes                                  |
| ------------- | --------- | -------------------------------------- |
| `mcpServerId` | `string`  | The targeted server id.                |
| `deleted`     | `boolean` | True when the soft-delete succeeded.   |

## Side effects

- Postgres: set `agent.mcp_servers.deleted_at`; tools stop registering immediately.
- Tool-descriptor snapshots retained >= 365 days before a retention job purges them.
- ClickHouse: emit `agent.mcp.deleted` audit event.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
