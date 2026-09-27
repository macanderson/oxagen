# ADR-211: Review refuses the HTTP+SSE transport

- **Status:** Accepted
- **Date:** 2026-09-27
- **Owners:** tools, steering
- **Related:** issue #4556, PR #4523 (M6 executor), ADR-209 (amended by
  decision 4 of this record).

## Context

MCP has two HTTP transports. Streamable HTTP is the current one. HTTP+SSE is
the older one, which the MCP specification replaced with streamable HTTP in its
2025-03-26 revision.

Until this record, `server.toml` accepted `transport = "sse"` on a remote
source, and the lock pinned a registry entry's sse remote as `transport: "sse"`.
The executor that PR #4523 merged calls MCP servers over streamable HTTP only,
and so does the relay. It refuses an sse server at call time. A steering PR
could therefore merge a server that every call then refused, and the person
who added it learned that at the first call instead of in the PR.

Issue #4556 asked for one choice: carry sse through the executor and the relay,
or refuse it at review. Carrying it means a second session model in the
executor, the relay, and the recorded exchanges, for a transport the
specification has already replaced. A server that still offers sse can add a
streamable-http endpoint, or run its package on the local gateway.

## Decision

1. **server.toml and the lock accept http only.** `remoteTransportSchema` in
   `packages/mcp-studio/src/contract/primitives.ts` is `z.enum(["http"])`.
   A remote source's `transport` and a registry lock source's `transport` both
   use it, and the JSON schemas under `packages/mcp-studio/schemas/` follow. A
   server folder that names sse fails review, and the steering PR's check
   prints `SSE_REFUSAL`: "sse is the older HTTP+SSE transport, which the gateway
   does not call. Point url at the server's streamable-http endpoint and set
   transport to http." Any other value keeps zod's message.
2. **The lock skips an sse remote.** `registryLockSource` in
   `packages/mcp-studio/src/lock/index.ts` pins a registry entry's first
   streamable-http remote. An entry that lists an sse remote and no
   streamable-http remote throws a message that says so and points at
   `source.machines`, which runs the entry's package instead.
3. **The executor keeps its refusal.** `checkTransport` in
   `packages/mcp-studio/src/execute/mcp.ts` still refuses sse before it sends
   anything. A manifest that reached the executor without review can still
   name it, so the check stays as a backstop.
4. **An sse row stays a legacy row.** `MOVABLE_TRANSPORTS` in
   `packages/agent/src/runtime/steering-pr.ts` is `["streamable-http"]`.
   `migrate()` moves live, enabled, legacy streamable-http rows only, and writes
   each moved row's transport as `http`. It lists an sse row in the PR body with
   its reason, as it lists a `stdio` row. `steeringWriter()` counts the rows the
   migration would move, so an sse row no longer holds a workspace on direct
   writes. The migration and the count select on one rule. If they differed, a
   workspace with one sse row would migrate every other server and then stay on
   direct writes until someone changed that row by hand. This amends decision 5
   of ADR-209 and its third consequence. The legacy path serves an sse row as
   it did before.
5. **The direct paths keep an sse server as a legacy row.** On a migrated
   workspace, `set_plugin_enabled` writes a plugin whose listing names sse as a
   legacy row, as it writes a `stdio` plugin, because a server folder cannot
   hold it. `register_mcp_server` already opened a steering PR for a
   streamable-http server only, so both paths now follow the same rule. When
   the plugin already has a row, `set_plugin_enabled` makes it an unnamed
   legacy row. A row that steering held before this record would otherwise
   stay under projection, which retires it once someone removes the folder
   review now refuses. `migrate()` also lists, instead of moving, a row that an
   earlier migration PR named when that row's transport has no folder form.

## Consequences

- A steering PR that adds an sse server fails its checks with a message that
  names streamable-http, instead of merging and failing at the first call.
- An sse server a workspace connected before this record keeps working through
  the legacy path. It stays out of the steering repo until someone points it at
  a streamable-http endpoint.
- The MCP Studio spec (`mcp-studio-spec.html` in the oxagen-roadmap
  repository) still lists sse in its Keys table and among the relay's
  protocols. That page lives outside this repository, and issue #4556 stays
  open until it matches.
- A registry install prefers streamable-http. `plugin.org.install.ts` picks
  the entry's first streamable-http remote when the catalog lists one, and
  takes the URL and the transport from that same remote. An entry that lists
  an sse remote before a streamable-http one therefore installs the
  streamable-http remote, which is the one its lock pins. An entry that offers
  only sse still installs as sse and stays a legacy row.
