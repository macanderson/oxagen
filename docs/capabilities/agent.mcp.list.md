# list_mcp_servers

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List registered external MCP servers in the active workspace with
their current health, tool counts, and last healthcheck timestamp. Each
server also reports how the workspace authenticates to it and, for an OAuth
provider, whether a token is held, when it lapses, and whether it renews
without a person (#4132). The app's provider status light reads these.

## Input

Empty object — workspace scope comes from the request envelope.

## Output

| Field     | Type                                                                       | Notes                       |
| --------- | -------------------------------------------------------------------------- | --------------------------- |
| `servers` | `Array<{ publicId, name, transportType, endpointUrl, healthStatus, lastHealthcheckAt, toolCount, authKind, iconUrl, authorization }>` | Server inventory. |

`authKind` is `oauth`, `bearer`, `header` or `none`. `authorization` is null
unless `authKind` is `oauth`, and then holds `state` (`connected`,
`needs_reauth`, `revoked` or `not_connected`), `expiresAt`, `refreshable` and
`lastRefreshedAt`. No token or secret column is read.

`endpointUrl` has any userinfo replaced with `***`, so
`https://user:secret@host/mcp` reads `https://***@host/mcp`. Registration
refuses such an address, but a row stored before that check can still hold
one.

## Side effects

None. It reads `mcp.mcp_servers`, joined to `plugin.installed_plugins` and
the status columns of `mcp.credentials`.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
