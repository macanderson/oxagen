# revoke_relay

**Capability:** `revoke_relay`
**Domain:** tool
**Mode:** sync
**Scope:** workspace (`scoped: true`; the relay belongs to the caller's workspace)
**Surfaces:** api, mcp
**Mutates:** yes
**Roles:** org Owner or Admin
**Billing gate:** skipped (`noBillingGate: true`, revoking a relay spends no model tokens)

## Intent

You suspect a relay token has leaked, or a relay's network is going away. This capability revokes the live relay with that name in your workspace (mcp-studio-spec, Network paths).

The broker refuses the relay's token at its next connect. It checks each connected relay's token again every 30 seconds, so a connected relay is closed within 30 seconds. Calls whose network is `relay:<name>` fail from then on. The name is free again, and [create_relay](tool.relay.create.md) may register a new relay with it and a new token.

## Reachability

- `POST /v1/:org_slug/:workspace_slug/tools/relays/revoke`, mounted in `apps/api/src/app.ts`.
- MCP tool `revoke_relay` (`apps/mcp/src/tools/tool.relay.revoke.ts`). Revoking puts no secret in a transcript, so an agent may revoke a relay it suspects is compromised. The tool is marked destructive and not idempotent.
- No page in the app. The app has no relay page yet, so an operator revokes a relay through the API or MCP. This is a known gap.

The contract's `agent` field sets `requiresApproval: true`, so an in-app agent turn pauses for a person's approval before it revokes a relay. The `api` and `mcp` surfaces do not read that flag. A machine-bound API key, such as a Tacho host key, is refused by the machine-key scope gate. The handler is registered in `packages/handlers/src/register.ts` and lives in `packages/handlers/src/mcp-studio/relays/revoke.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | `^[a-z0-9][a-z0-9-]{0,62}$`, the name `create_relay` registered |

The input takes no other field. The workspace comes from the URL or the API key, never the input.

## Output

| Field | Type | Description |
|---|---|---|
| `publicId` | string | the relay's id, `rly_` and 22 characters |
| `name` | string | the name in the input |
| `revokedAt` | string | ISO 8601 time the relay was revoked |

The route answers `200`.

## Side effects

Sets `revoked_at` and `revoked_by_id` on at most one `mcp.relays` row, the live relay with this name in the caller's workspace. The write runs through `withSystemDb`, because the broker's verifier reads the same table before any organization is known. The statement carries the caller's `org_id` and `workspace_id` predicates. The row stays in the table as the record of the relay.

The kernel's `capability.invoke_*` events audit the call, and the contract's `audit` field names the relay. The handler logs `revoke_relay: relay revoked` with the relay's id and name.

## Errors

| code | reason | meaning |
|---|---|---|
| `not_found` | `relay_not_found` | the workspace has no live relay with this name. A relay already revoked, or one in another workspace, answers the same way |
| `forbidden` | `org_role_required` | the caller is not an org Owner or Admin |
| `forbidden` | `no_principal` | the call carries no user, or its API key is deleted or has no recorded creator |
| `invalid_input` | | the name does not match its pattern, the name is missing, or an unknown key is present |
