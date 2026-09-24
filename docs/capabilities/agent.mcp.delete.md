# delete_mcp_server

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

## App

Tools › Providers at `/{org}/{ws}/tools/providers`: **Remove** on a provider row and in the provider drill-down. The dialog says what stops working and what is kept for replay before it asks, and says nothing was removed when the answer is `deleted: false`. The handler asserts an organization Owner or Admin, or a workspace Owner.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
