# ADR-225: A private-network relay dials out to the MCP service and acts only on signed calls

- **Status:** Proposed
- **Date:** 2026-09-28
- **Owners:** mcp, relay
- **Decided by:** Mac assigned the relay to lane M12 on 2026-09-28 (#4685).
  The coordinator ruled on the token store, the 30-second revocation bound,
  the upgrade mount, one broker per process, and the surfaces on the same
  day. The other details were chosen under SCR-002 and await acceptance.
- **Related:** issue #4685 (lane M12), PR #4698 (part 1, merged as
  e1ce3b977), PR #4714 (merged as dbec3a9d2), PR #4720 (part 2 and this
  record), issue #4666 (the served-call gates, after which the
  `relay_not_built` refusal goes), issue #4712 (CI builds neither the relay
  image nor the chart), ADR-042 (tenant data planes), and ADR-187 (two
  gateways carry every customer agent's traffic)

## Context

A customer's servers and APIs often sit in a private network. The MCP
service's served tools run in Oxagen's cloud and cannot reach them. Asking the
customer to open an inbound port, run a VPN, or set up a private link puts
network work in front of every customer, and many refuse an inbound port
outright.

The served tools already pick a Transport per network: `local` for a server
on an operator's machine, the cloud transport for a public host, and
`relay:<name>` for a private network. Until this record, the last one ended
every call with `relay_not_built`.

Four questions had to be settled. Which side opens the connection. What the
relay trusts. Where the broker runs, given that xmcp owns the MCP service's
HTTP server. And how fast a revoked relay stops.

## Decision

1. **The relay dials out.** `apps/relay` runs inside the customer's network.
   It opens one WebSocket to `wss://mcp.oxagen.sh/relay/v1/connect`, presents
   its relay token as a bearer header, and sends a heartbeat every 20
   seconds. It opens no port. The broker marks a connection down after three
   missed heartbeats and fails its open calls. It never replays a call on
   another connection.
2. **The relay acts only on a signed envelope.** For each call the broker
   signs a `relay-envelope/v1` with Ed25519. The envelope names the relay,
   the workspace's public id, a nonce, the target, the hashes of the headers
   and the body, and the deadline. It expires 10 seconds after issue. The
   relay trusts only the public keys in `RELAY_TRUSTED_KEYS`, and it refuses
   an envelope that is unsigned, replayed, expired, meant for another relay
   or workspace, or aimed at a host outside `RELAY_ALLOWED_HOSTS`. When the
   gateway stops signing, the relay has nothing it can act on.
3. **One key signs.** The broker signs with
   `TACHO_BUNDLE_SIGNING_PRIVATE_KEY`, the key that already signs Tacho
   policy bundles and local server calls. The MCP service builds its broker
   from that key on start. With no key, or a key that does not load, it
   builds no broker. It then mounts no upgrade listener, and every relay call
   ends as `unsupported` with nothing sent. To rotate the key, add the new
   public key to each relay's `RELAY_TRUSTED_KEYS`, then change the key.
4. **The broker lives in the MCP service.** `packages/relay-broker` holds
   the broker, and `apps/mcp/src/relay/` mounts it. The served calls start
   in the MCP service, so a broker there needs no second hop. The broker
   knows nothing of xmcp, so moving it to its own service later changes only
   the mount.
5. **The mount rides Node's diagnostics channel.** xmcp 0.6.13 builds its
   HTTP server inside its runtime. It exports no handle to that server and
   no hook that runs when it starts. The mount subscribes to
   `http.server.request.start`. When a server answers its first request, the
   mount adds its upgrade listener, unless the server already has one.
6. **The first request after a start names the server.** Node decides
   whether a request is an upgrade before it publishes
   `http.server.request.start`. So an upgrade that reaches a fresh process
   before any other request is answered as a plain request, at once, with a
   status other than 101. That request names the server, and the relay's
   next dial one second later reaches the broker. A test in
   `apps/mcp/src/relay/mount.test.ts` holds that the first upgrade gets an
   answer and does not hang. When xmcp exposes its server or a start hook,
   the mount moves there and this dependency goes.
7. **One broker per process.** The broker holds its connections in memory,
   so a call reaches a relay only from the process the relay connected to.
   The MCP service runs as one container on one shared node today
   (`infra/tools/node`). A call with no connection in its process ends at
   once as `disconnected`, with nothing sent. Before the MCP service runs a
   second process, the broker needs a shared route table or the connect
   needs pinning.
8. **Relay tokens are stored as hashes.** `mcp.relays` holds each relay's
   organization, workspace, name, and the SHA-256 of its `oxr_` token. The
   plaintext token appears once, in the answer to `create_relay`. The table
   sits on the shared plane and is read with `withSystemDb`, because the
   broker checks a token before it knows the tenant. The broker then checks
   the relay's hello against the record's workspace and name, and closes a
   connection whose hello does not match with WebSocket code 4003.
9. **A revoked relay stops within 30 seconds.** `revoke_relay` marks the
   record revoked. The broker refuses the relay's next connect with 401. It
   checks each live connection's token every 30 seconds, and when the token
   no longer checks, it stops routing to the connection, fails its open
   calls, and closes it with WebSocket code 4001. When the check itself fails,
   the connection stays and the next interval checks again. A revoke made
   during a database outage takes effect on the first check that succeeds.
10. **`create_relay` is on the API only.** Over MCP, the plaintext token
    would land in the agent's transcript. `revoke_relay` is on the API and
    MCP. Neither has a screen in the app yet.
11. **A relay may add a credential on the Enterprise plan.** An envelope may
    name a credential that the relay adds from its own environment, as a
    bearer token, basic auth, or a named header. The secret never leaves the
    customer's network. The broker refuses to name a credential for an
    organization below the Enterprise plan.

## Consequences

- A customer runs one outbound container per network segment and opens no
  port. Revoking its token is the kill switch, bounded at 30 seconds.
- Removing the signing key from the MCP service stops every relay call on
  the next start. A relay that holds a connection receives nothing, because
  the broker has nothing signed to send.
- The MCP service holds a WebSocket per connected relay. Calls to one relay
  from another MCP process fail as `disconnected` until the broker is
  shared.
- A relay's first dial after an MCP deploy can be answered with a plain
  status, and it succeeds one second later.
- CI does not yet build the relay image or render the chart (#4712).

## Alternatives considered

- **Inbound access** (an open port, a VPN, or a private link). Each needs
  network work per customer, and many customers refuse an inbound port.
- **A separate relay service at its own host.** It needs another deploy
  target, a DNS record, and a Caddy block. The served calls start in the MCP
  service, so each call would cross a second hop. The broker package keeps
  this open for later.
- **Patching `http.Server` or `http.createServer` to find xmcp's server.**
  It changes every server in the process, including ones the relay has no
  business with. The diagnostics channel is a public Node interface.
- **Storing the token encrypted.** The broker only compares tokens, so a
  hash is enough, and a leaked table holds nothing that connects.
- **Pushing revocations** (Postgres `LISTEN`/`NOTIFY`). It needs a held
  database connection per process and still needs a fallback check. A
  30-second poll is simpler and its bound is stated.
