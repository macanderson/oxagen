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
| `servers` | `Array<{ publicId, name, transportType, endpointUrl, healthStatus, lastHealthcheckAt, toolCount, authKind, iconUrl, authorization, contextTokens, weeklyPrice, steeringName }>` | Server inventory. |

`contextTokens` is the tokens the server's tool definitions add to a model
call (#4537). It comes from the newest system context the recorder listed in
the last 7 days whose tool part names the server. It is null when no listing
names the server.

`weeklyPrice` is what those tokens cost the workspace over the same 7 days, as
`{ micros, currency, basis: "estimated" }`. Each of the workspace's model
calls of the week is priced at the book's cache read rate in force when it
ran, or at its input rate when it read nothing from the cache. The estimate
assumes every call sent the server's definitions. A call the book has no rate
for adds nothing, so the figure is a floor for such a week. `weeklyPrice` is
null when `contextTokens` is null or when the book priced none of the week's
calls. The Providers table shows it as the server's weekly price.

`authKind` is `oauth`, `bearer`, `header` or `none`. `authorization` is null
unless `authKind` is `oauth`, and then holds `state` (`connected`,
`needs_reauth`, `revoked` or `not_connected`), `expiresAt`, `refreshable` and
`lastRefreshedAt`. No token or secret column is read.

`steeringName` is the server's folder under `tools/servers/` in the steering
repo, for a server a steering repo defines. It is null for a server added any
other way. Studio names a server by this folder in every call, so the server
page reads it from here before it reads the folder itself (#4678).

`endpointUrl` has any userinfo replaced with `***`, so
`https://user:secret@host/mcp` reads `https://***@host/mcp`. Registration
refuses such an address, but a row stored before that check can still hold
one.

## Side effects

None. It reads `mcp.mcp_servers`, joined to `plugin.installed_plugins` and
the status columns of `mcp.credentials`. From ClickHouse it reads the tool
parts of the week's model calls, and the week's calls by model. From the price
book it reads the rates for those models. When the tool part read fails, the
servers still list, and `contextTokens` and `weeklyPrice` read null. When the
price read fails, `weeklyPrice` reads null.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- §2.3 — external MCP client
- §4 — new capabilities
