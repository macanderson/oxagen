# create_relay

**Capability:** `create_relay`
**Domain:** tool
**Mode:** sync
**Scope:** workspace (`scoped: true`; the relay belongs to the caller's workspace)
**Surfaces:** api
**Mutates:** yes
**Roles:** org Owner or Admin
**Billing gate:** skipped (`noBillingGate: true`, registering a relay spends no model tokens)

## Intent

You have servers and APIs inside a private network that Oxagen cannot reach. A relay runs inside that network and connects out to Oxagen's broker. This capability registers the relay by name and mints its relay token (mcp-studio-spec, Network paths).

The token is `oxr_` and 43 base64url characters. The response shows it once. Oxagen stores only its SHA-256 in `mcp.relays`, so no one can read the token again. Start the relay with the token. A call whose network is `relay:<name>` then routes through it.

A workspace holds one live relay per name. Revoke a relay with [revoke_relay](tool.relay.revoke.md) to free its name.

## Reachability

- `POST /v1/:org_slug/:workspace_slug/tools/relays`, mounted in `apps/api/src/app.ts`.
- No MCP tool. The response carries the plaintext token, and an MCP tool would put that token in the agent's transcript. The contract declares the `api` surface alone for that reason.
- No page in the app. The app has no relay page yet, so an operator registers a relay through the API. This is a known gap.

An org Owner or Admin calls it with a session, or with the API key `oxagen login` minted for them. A machine-bound API key, such as a Tacho host key, is refused by the machine-key scope gate. The handler is registered in `packages/handlers/src/register.ts` and lives in `packages/handlers/src/mcp-studio/relays/create.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, the `<name>` in a call's `relay:<name>` network |

The input takes no other field. The workspace comes from the URL, never the body.

## Output

| Field | Type | Description |
|---|---|---|
| `publicId` | string | the relay's id, `rly_` and 22 characters |
| `name` | string | the name in the input |
| `createdAt` | string | ISO 8601 time the relay was registered |
| `token` | string | the relay token, starting `oxr_`. Shown once. Oxagen cannot show it again |

The route answers `201`.

## Side effects

Inserts one `mcp.relays` row through `withSystemDb`. The broker's verifier reads the same table by token hash before any organization is known, so the table sits on the shared plane. Every statement carries the caller's `org_id` and `workspace_id` predicates. The row records `token_hash`, `created_at`, and `created_by_id`, the acting user.

The kernel's `capability.invoke_*` events audit the call, and the contract's `audit` field names the relay. The handler logs `create_relay: relay registered` with the relay's id and name. It never logs the token.

## Errors

| code | reason | meaning |
|---|---|---|
| `conflict` | `relay_name_taken` | the workspace already has a live relay with this name. Revoke it first, or choose another name |
| `not_found` | `workspace_not_found` | the workspace is not in the caller's organization |
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `forbidden` | `no_principal` | the call carries no user, or its API key is deleted or has no recorded creator |
| `invalid_input` | | the name does not match its pattern, the name is missing, or an unknown key is present |
