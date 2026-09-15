# agent.retire

**Capability:** `retire_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a governance write on the identity)

## Intent

Retire an agent identity (MC spec §6.2, App. E; #2956; the Deregister action). One transaction archives the agent row, suspends its principal, soft-deletes every live credential and revokes every live host — the host key retired and a `revoke` command queued, the same three writes `revoke_tacho_enrollment` makes. Nothing is deleted: runs keep the agent's key and principal. Retiring a retired agent answers the recorded retirement without a write.

The definition file in git is not touched here; removing it is a pull request through `commit_agent_definition`.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…` or slug. |
| `reason` | `string?` | Up to 512 chars, recorded on the principal, the hosts and the commands. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `status` | `"retired"` | |
| `revokedCredentials` | `number` | Credentials soft-deleted by this call. |
| `revokedHosts` | `number` | Hosts revoked by this call. |
| `retiredAt` | `string` | ISO-8601. |

## Roles

Org Owner or Admin, checked by the handler (INV-29).

## Side effects

- Postgres: `agent.agents.status = archived`, `iam.principals.status = suspended`, the agent's `auth.api_keys` and each host's key soft-deleted, `tacho.hosts.status = revoked`, one `tacho.control_commands` `revoke` row per host.
- Security events `agent.retired` and, when anything was revoked, `api_key.revoked`.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/retire`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user, or not an org Owner or Admin. |
| `not_found` | No live agent with that id or slug (`agent_not_found`). |
