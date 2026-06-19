# agent.mcp.set_enabled

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Enable or disable a registered external MCP server. Disabling stops its
tools from registering but keeps tool-descriptor snapshots for replay;
re-enabling re-captures snapshots. The change is audited.

## Input

| Field         | Type      | Notes                                       |
| ------------- | --------- | ------------------------------------------- |
| `mcpServerId` | `string`  | ID of the registered external MCP server.   |
| `enabled`     | `boolean` | True to enable, false to disable.           |

## Output

| Field           | Type      | Notes                                                 |
| --------------- | --------- | ----------------------------------------------------- |
| `mcpServerId`   | `string`  | The targeted server id.                               |
| `enabled`       | `boolean` | The resulting enabled state.                          |
| `snapshotCount` | `number`  | Count of tool-descriptor snapshots retained/captured. |

## Side effects

- Postgres: update `agent.mcp_servers.enabled`; capture/retain `agent.mcp_tool_snapshots`.
- ClickHouse: emit `agent.mcp.set_enabled` audit event.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
