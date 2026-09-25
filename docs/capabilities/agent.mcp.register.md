# register_mcp_server

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Register an external MCP server with the workspace. The runner runs a
health check, discovers the server's tools, and proxies them under the
agent's tool surface so they behave like first-class Oxagen tools.

## Input

| Field           | Type                                  | Notes                                       |
| --------------- | ------------------------------------- | ------------------------------------------- |
| `name`          | `string` (1 – 120 chars)              | Human label shown in the UI.                |
| `transportType` | `"streamable-http" \| "stdio"`        | StreamableHTTP is the default.              |
| `endpointUrl`   | `string` (URL)                        | Public `http:` or `https:` URL. See below.  |
| `authStrategy`  | `"none" \| "bearer" \| "header"`      | Defaults to `"none"`.                       |
| `authConfig`    | `Record<string,string>?`              | Credentials per strategy.                   |

Every transport checks `endpointUrl` before the health check and before
the insert. The handler refuses an address that carries a username or a
password, that is not `http:` or `https:`, or that resolves to a loopback,
private, link-local, or cloud-metadata address. A `stdio` server is not
probed, but its address is stored and shown, so it gets the same check.

## Output

| Field             | Type                                       | Notes                                  |
| ----------------- | ------------------------------------------ | -------------------------------------- |
| `mcpServerId`     | `string`                                   | Prefixed with `mcp_`.                  |
| `healthStatus`    | `"healthy" \| "degraded" \| "unreachable"` | Result of the initial healthcheck.     |
| `discoveredTools` | `string[]`                                 | Tool names found via `tools/list`.     |

## Side effects

- Postgres: insert `agent.mcp_servers` row plus per-tool rows in `agent.mcp_tools`.
- Neo4j: upsert `(:McpServer { public_id })-[:HAS_TOOL]->(:McpTool)`.
- ClickHouse: emit `agent.mcp.registered` event.

## Errors

| code                  | meaning                                          |
| --------------------- | ------------------------------------------------ |
| `endpoint_unreachable` | Initial healthcheck failed.                     |
| `auth_invalid`         | Server rejected the supplied credentials.       |
| `name_taken`           | Workspace already has a server with that name.  |

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
