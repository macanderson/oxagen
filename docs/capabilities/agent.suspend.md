# suspend_agent

**Capability:** `suspend_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a governance write on the identity)

## Intent

Stop an agent identity without retiring it (MC spec §6.2; #2956). The principal's status becomes `suspended`: the runtime builds no run context for a suspended principal (`packages/iam/src/agent-run-context.ts`), so no governed run starts for it and `get_agent_toolbelt` reports an empty belt. Credentials, roles and hosts stay as they are, so a resume (`suspended: false`) is one status write back to `active`. The long-lived credential is locked to the run-token exchange of spec §6.2, which no surface serves yet (ADR-057 §4). Suspending a suspended agent, or resuming an active one, answers the current state without a write.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…` or slug. |
| `suspended` | `boolean` | Default true; false resumes. |
| `reason` | `string?` | Up to 512 chars, recorded on the principal. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `status` | `"suspended" \| "active"` | |
| `changedAt` | `string` | ISO-8601. |

## Roles

Org Owner or Admin, checked by the handler (INV-29).

## Side effects

- Postgres: `iam.principals.status` on the agent's principal.
- Security event `agent.suspended` or `agent.resumed` when the status changed.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/suspend`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user and no API key with a live creator (`no_principal`), or the acting user (the signed-in user, or the key's creator) is not an org Owner or Admin (`org_role_required`). |
| `forbidden` | A suspend names the built-in assistant stella acts as (`qa-chat`), whose principal every stella turn runs under (`agent_managed_read_only`, #4350). A resume of it is allowed. |
| `not_found` | No live agent with that id or slug (`agent_not_found`). |
| `conflict` | The agent is retired (`agent_retired`) or has no delegated principal (`agent_principal_missing`). |
