# rotate_agent_credential

**Capability:** `rotate_agent_credential`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a credential write)

## Intent

Replace an agent's long-lived credential (MC spec §6.2; #2956). Every live credential of the agent is soft-deleted and the replacement minted in the same transaction, so there is no moment with two live secrets and none with zero. The old secret is refused at its next presentation. The new secret is returned once.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…` or slug. |
| `validityDays` | `number` | 1–365; default 180. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `revokedCredentialId` | `string \| null` | The credential that was retired; null when the agent held none. |
| `credential.id` / `.secret` / `.expiresAt` | | As in `register_agent`; the secret is shown once. |

## Roles

Org Owner or Admin, checked by the handler (INV-29).

## Side effects

- Postgres: the old `auth.api_keys` rows soft-deleted, one new row inserted, one transaction.
- Security events `api_key.revoked` (when a key was live) and `api_key.created`.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/credential/rotate`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user and no API key with a live creator (`no_principal`), or the acting user (the signed-in user, or the key's creator) is not an org Owner or Admin (`org_role_required`). |
| `forbidden` | The agent is the built-in assistant stella acts as (`qa-chat`). A credential for it would act as stella's principal (`agent_managed_read_only`, #4350). |
| `not_found` | No live agent with that id or slug (`agent_not_found`). |
| `conflict` | The agent is retired (`agent_retired`) or has no delegated principal (`agent_principal_missing`). |
