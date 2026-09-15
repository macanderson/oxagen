# agent.register

**Capability:** `register_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, cli
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Mint an agent identity in the workspace (MC spec §6.2, App. E; #2956; shared with the onboarding flow and `oxagen agent register`). One transaction inserts the `agent.agents` row (status `draft`, deployment `inactive`, the harness as given), its delegated `iam.principals` row (kind `agent`, acting for the registering user), the org's default agent role when it is seeded, and the long-lived credential: an `auth.api_keys` row whose scope carries the server-owned purpose `agent_credential_v1` bound to the agent and its principal. The raw key is returned once and never stored. `resolveApiKey` refuses a key carrying that purpose on every surface (`purpose_locked`): the credential is for the run-token exchange of spec §6.2, which is not built, and it never authorizes as the user who minted it (ADR-057 §4).

Registration writes no definition: the definition of record is the file `.oxagen/agents/<slug>.toml` in the workspace repository, written by `commit_agent_definition` (ADR-057 decision 1).

## Input

| Field | Type | Notes |
|---|---|---|
| `slug` | `string` | 1–18 chars, lowercase words joined by hyphens. Reserved for good in the workspace: a soft-deleted agent keeps its slug (ADR-024). |
| `name` | `string` | 1–128 chars. |
| `description` | `string?` | Up to 1024 chars. |
| `harness` | `"stella" \| "claude-code" \| "claude-agent-sdk" \| "custom"` | |
| `validityDays` | `number` | Credential lifetime, 1–365; default 180. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…`. |
| `slug` | `string` | |
| `agentKey` | `string \| null` | Null until the namespaces are backfilled. |
| `principalId` | `string` | `prn_…`. |
| `credential.id` | `string` | `aky_…`. |
| `credential.secret` | `string` | Shown once. Never recoverable. |
| `credential.expiresAt` | `string` | ISO-8601. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole`, INV-29). A call with no signed-in user (an API key alone) is refused with `forbidden`, reason `no_principal`.

## Side effects

- Postgres: one `agent.agents`, one `iam.principals`, one `iam.principal_role_assignments` (when the default role exists) and one `auth.api_keys` row, in one tenant-scoped transaction.
- Security events `agent.registered` and `api_key.created`.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/register`
- CLI `oxagen agent register`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user (`no_principal`), or the user is not an org Owner or Admin (`org_role_required`). |
| `conflict` | The slug is already used in this workspace (`agent_slug_taken`). |
