# credential.grant.list

**Capability:** `list_credential_grants`
**Domain:** credential
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

The Connections tab's grants log (MC spec §6.8; ADR-068 §6). A wrapped agent holds no credentials: when the tool gateway reaches an MCP server on a run's behalf it presents the workspace's stored credential (`mcp.credentials`, the connection) server-side, and every such use is one `mcp.credential_grants` row naming the connection, the server, the run, the scope the credential could reach (endpoint, auth kind, downscope method — `none` today: the stored credential used for this connection only) and its lifetime (one hour at most). The secret never lands on the row and is never returned.

A revoked connection's grants die with it: deleting a credential and flipping a connection kill switch on both revoke the connection's live grants, and while a connection or tool-server switch is on the gateway leaves the server out of every turn before its credential is presented, so no new grant is minted (`packages/agent/src/runtime/plugin-types/mcp.ts`). A grant is written before the credential is presented.

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
- MCP tool `list_credential_grants` (an API key acts as its creator at the role gate, ADR-068 decision 8)

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or no qualifying role |
| `invalid_input` | a cursor this capability did not write |
