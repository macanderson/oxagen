# register_agent

**Capability:** `register_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, cli
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a settings write)

## Intent

Mint an agent in the workspace (ADR-192; MC spec §6.2; shared with the register flow and `oxagen agent register`). An agent is the IAM principal for one operator on one runtime with one harness: your laptop with Claude Code is one agent. The registering user is the operator.

One transaction inserts:

- the `agent.agents` row (status `draft`, deployment `inactive`, the harness as given, the runtime and the toolbelt),
- its delegated `iam.principals` row (kind `agent`, acting for the registering user),
- the org's default agent role, when it is seeded,
- version 1 in `agent.agent_versions` (`change_kind = 'registered'`), recording the runtime and the toolbelt,
- the long-lived credential: an `auth.api_keys` row whose scope carries the server-owned purpose `agent_credential_v1` bound to the agent and its principal.

The raw key is returned once and never stored. `resolveApiKey` refuses a key carrying that purpose on every surface (`purpose_locked`): the credential is for the run-token exchange of spec §6.2, and it never authorizes as the user who minted it (ADR-057 §4).

The agent carries no prompt and no definition file. It carries a toolbelt, which `assign_agent_toolbelt` can change, and a runtime, which `move_agent` can change. Each change writes the next version and keeps the principal.

## Input

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | 1 to 128 characters. |
| `slug` | `string?` | 1 to 18 characters, lowercase words joined by hyphens. Derived from `name` when absent: spaces become hyphens and every other special character, apostrophes included, is dropped. Reserved for good in the workspace: a deleted agent keeps its slug (ADR-024). |
| `description` | `string?` | Up to 1024 characters. |
| `harness` | `"stella" \| "claude-code" \| "codex" \| "cursor" \| "claude-agent-sdk" \| "custom"` | |
| `runtimeId` | `string` | `rtm_…`, a runtime in this workspace (`create_runtime`). |
| `toolbeltId` | `string?` | `tbt_…`. The workspace's All tools belt when absent. |
| `validityDays` | `number` | Credential lifetime, 1 to 365; default 180. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…`. |
| `slug` | `string` | |
| `agentKey` | `string \| null` | Null until the namespaces are backfilled. |
| `principalId` | `string` | `prn_…`. |
| `runtime` | object | `id` (`rtm_…`), `name`, `slug`. |
| `toolbelt` | object | `id` (`tbt_…`), `name`, `slug`, `kind` (`all_tools` or `custom`). |
| `version` | `number` | The first version, 1. |
| `credential.id` | `string` | `aky_…`. |
| `credential.secret` | `string` | Shown once. Never recoverable. |
| `credential.expiresAt` | `string` | ISO-8601. |

## Roles

Org Owner or Admin, checked by the handler (`assertOrgRole`, INV-29) for the signed-in user or, on an API-key call, the key's creator (`resolveActingUserId`). That user is recorded as the credential's creator and the principal's parent. A call with no signed-in user and no API key with a live creator is refused with `forbidden`, reason `no_principal`.

## Side effects

- Postgres: one `agent.agents`, one `iam.principals`, one `iam.principal_role_assignments` (when the default role exists), one `agent.agent_versions` and one `auth.api_keys` row, in one tenant-scoped transaction. The workspace's All tools belt is created the first time a toolbelt path needs it.
- Security events `agent.registered` and `api_key.created`.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/register`
- CLI `oxagen agent register`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user and no API key with a live creator (`no_principal`), or the acting user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | The runtime (`runtime_not_found`) or the toolbelt (`toolbelt_not_found`) is not in this workspace. |
| `conflict` | A live agent already runs the harness on the runtime (`runtime_harness_taken`; the message names it), the slug is already used in this workspace (`agent_slug_taken`), or the name has no letter or digit to derive a slug from (`agent_slug_empty`). |
