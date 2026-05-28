# agent.mcp.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List registered external MCP servers in the active workspace with
their current health, tool counts, and last healthcheck timestamp.

## Input

Empty object — workspace scope comes from the request envelope.

## Output

| Field     | Type                                                                       | Notes                       |
| --------- | -------------------------------------------------------------------------- | --------------------------- |
| `servers` | `Array<{ publicId, name, transportType, endpointUrl, healthStatus, lastHealthcheckAt, toolCount }>` | Server inventory. |

## Side effects

None — read-only against `agent.mcp_servers` and `agent.mcp_tools`.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
