# search_mcp_registry

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).
**Risk level:** low

## Intent

Find an MCP server to add as a tool provider. The search reads two sources:

- **Verified first-party servers.** A short list Oxagen keeps, in
  `packages/agent/src/runtime/verified-mcp-servers.ts`. It holds remote servers
  their vendors run, such as Linear, Slack, GitHub, Notion, Atlassian and
  Sentry. Several of these, Slack among them, are not published to any
  registry. They are listed first on the first page.
- **The official MCP Registry** at `registry.modelcontextprotocol.io`, API
  v0.1. The Model Context Protocol project runs it, with Anthropic, GitHub,
  Microsoft and PulseMCP as maintainers. A reverse-DNS name such as
  `app.linear/linear` is published only after its owner proves the domain, and
  an `io.github.<user>/…` name only by that GitHub account. The read API needs
  no key.

The registry's `server.json` cannot say whether a server uses OAuth. A remote
server that declares no secret header is therefore probed with a 2.5-second
bound: RFC 9728 protected-resource metadata, or a 401 on `initialize`. The
answer is cached for 30 minutes. Every probe goes through the SSRF guard in
`runtime/mcp-oauth-fetch.ts`.

## Input

| Field    | Type                  | Notes                                                    |
| -------- | --------------------- | -------------------------------------------------------- |
| `query`  | `string` (≤ 120)      | Matched against name, title and description. Default `""`. |
| `cursor` | `string?`             | The `nextCursor` of the page before.                     |
| `limit`  | `number` (1 – 30)     | Registry results per page. Default 20.                   |

## Output

| Field               | Type               | Notes                                                        |
| ------------------- | ------------------ | ------------------------------------------------------------ |
| `servers`           | `McpRegistryServer[]` | See below.                                                |
| `nextCursor`        | `string \| null`   | Null on the last page, or when the registry was unreachable. |
| `registryReachable` | `boolean`          | False when the registry could not be read; the verified entries still answer. |

Each server carries `id`, `name`, `description`, `publisher`,
`publisherVerified`, `source` (`verified` or `registry`), `version`,
`iconUrl`, `websiteUrl`, `docsUrl`, `repositoryUrl` (https only),
`endpointUrl` (the streamable-http endpoint Oxagen would reach), `transports`,
`auth` (`oauth`, `bearer`, `header`, `none` or `unknown`), `authHeader`,
`oauthRegistration` (`dynamic`, `client_required` or `unknown`),
`connectable`, and `packages`. A server with only `sse` or `stdio` is listed
with `connectable: false`.

`packages` lists what a machine can run, empty for a remote-only entry. Each
package carries `registryType`, `identifier`, `version`, `transport`,
`runtimeHint`, `packageArguments`, and `environmentVariables`. Each argument
is `named` or `positional`, with `name`, `valueHint`, `isRequired`,
`isSecret`, `value` (a fixed value the registry sets) and `default`. An
argument of another type is dropped. Each variable carries a name and whether
it is required or secret, never a value. Studio's Add server dialog asks for
the required arguments that have no fixed value (#4678).

## Side effects

None. It reads public metadata.

## Errors

None beyond auth and scope failures. An unreachable registry is reported in
`registryReachable`, not thrown.
