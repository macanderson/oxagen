# list_credential_grants

**Capability:** `list_credential_grants`
**Domain:** credential
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The Connections tab's grants log (MC spec §6.8; ADR-072 §6). A wrapped agent holds no credentials: when the tool gateway reaches an MCP server on a run's behalf it presents the workspace's stored credential (`mcp.credentials`, the connection) server-side, and every such use is one `mcp.credential_grants` row naming the connection, the server, the run, the scope the credential could reach (endpoint, auth kind, downscope method — `none` today: the stored credential used for this connection only) and its lifetime (one hour at most). The secret never lands on the row and is never returned.

A revoked connection's grants die with it: deleting a credential and flipping a connection kill switch on both revoke the connection's live grants, and while a connection or tool-server switch is on the gateway leaves the server out of every turn before its credential is presented, so no new grant is minted (`packages/agent/src/runtime/plugin-types/mcp.ts`). A grant is written before the credential is presented.

## The log outlives what it names

A grant row carries the connection's `mcrd_…` public id AND the server's `mcs_…` public id and name as they were **at mint time**, and reads them straight off the row rather than joining. Both subjects can be deleted while the log stands: revoking a credential deletes the `mcp.credentials` row, and `uninstall_plugin` hard-deletes the `mcp.mcp_servers` rows, which is why `mcp_server_id` carries no foreign key. Joining to the server threw `RangeError` on the first orphan — page 1, under a newest-first order, with no cursor past it and no filter around it — so one uninstall made this audit surface permanently unreadable for the workspace. Denormalising at mint time (ADR-071) is why it reads instead.

Rows are kept 90 days past the point they stopped being live (`revoked_at` where revoked, `expires_at` otherwise) and then deleted by the `mcp.credential-grant-retention` weekly cron. The durable record of a credential *use* is the tool invocation in ClickHouse and the security event; this table answers "what could a credential still reach, and what did it reach recently".

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `connectionId` | string | no | `mcrd_…`; only grants drawn on it |
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page |

## Output

| Field | Type | Description |
|---|---|---|
| `items` | object[] | newest first |
| `nextCursor` | string or null | |

Each row: `id` (`mcgr_…`), `connectionId` (`mcrd_…`, as it was at mint time), `serverId` (`mcs_…`), `serverName`, `runId` (null for a turn outside a run), `scope` (`{ endpointUrl, authKind: oauth | secret, downscope: token_exchange | session_policy | restricted_key | none }`), `providerTokenId`, `issuedAt`, `expiresAt`, `revokedAt`, `status` (`active`, `expired`, `revoked`).

## Roles

Org Owner, Admin or Compliance (`assertOrgRole`, INV-29).

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /v1/{org}/{ws}/credential-grants`
- MCP tool `list_credential_grants` (an API key acts as its creator at the role gate, ADR-072 decision 8)
- App: **Tools → Providers** at `/{org}/{ws}/tools/providers`: the credential grants log under the providers table.

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `invalid_input` | a cursor this capability did not write |
