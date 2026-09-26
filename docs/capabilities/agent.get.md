# get_agent

**Capability:** `get_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp, agent, cli
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

One agent in one read (ADR-198; MC spec §6.2, App. E; #2956): the identity, the runtime it runs on and the toolbelt it carries, its versions, every long-lived credential it has held, the roles on its principal, and the hosts enrolled under its agent key. The read behind the Agents detail page and the CLI's `oxagen agent status`.

An agent is one operator on one runtime with one harness. The principal, the operator and the harness never change; `versions` records each runtime and toolbelt the agent has had, newest first. No secret leaves this read: a credential shows its prefix and dates, a host its device-key fingerprint. The contract test refuses any output field named like a secret, a hash or a key.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | The agent's public id (`agt_…`) or slug. |

## Output

| Field | Type | Notes |
|---|---|---|
| `identity` | object | `id`, `slug`, `name`, `description`, `agentKey`, `harness`, `managed`, `principalId`, `operatorId`, `status`, `registeredAt` as in `list_agents`; `firstFrameAt` is the start of the earliest run either store recorded, null before the first. `costCenter` is the label `set_cost_center` stored on the agent (ADR-142), null when the agent inherits the workspace's. |
| `credentials[]` | object | `id` (`aky_…`), `name`, `prefix`, `createdAt`, `expiresAt`, `lastUsedAt`, `revokedAt` — revoked credentials stay listed with their date. Newest first. |
| `roles[]` | object | `id` (`rol_…`), `name`, `scopeKind`, `isSystemDefault`, `assignedAt`, `expiresAt` — the live, unexpired assignments on the agent's principal. |
| `hosts[]` | object | `hostEnrollmentId` (`tch_…`), `hostname`, `platform`, `status`, `mode`, `harnesses`, `deviceKeyFingerprint`, `collectorVersion`, `hooksOk`, `bundleVersionServed`, `lastSeenAt`, `expiresAt`, `revokedAt`. Newest first, revoked hosts included. |
| `runtime` | object \| null | `id` (`rtm_…`), `name`, `slug`. Null for an agent that runs on no named runtime, such as stella's in-app assistant. |
| `toolbelt` | object \| null | `id` (`tbt_…`), `name`, `slug`, `kind`. An agent that names no belt reads as the workspace's All tools belt; null only before any toolbelt path has touched the workspace. |
| `versions[]` | object | `version`, `changeKind` (`registered`, `runtime_changed`, `toolbelt_changed`, `legacy`), `runtime`, `toolbelt`, `createdBy` (`usr_…`), `createdAt`. Newest first, at most 100. A `legacy` version, written before ADR-198, names no runtime or toolbelt. |
| `limits` | object | The ceilings the active version's config sets, read the way the host bundle reads them: `perRun` and `perDay` (`{ micros, currency }`, null when unset), `containmentRequired`, and `invalid`, true when the config cannot be read and the host suspends governed actions. |

## Roles

Org Owner, Admin, Member; workspace Owner, Member.

## Side effects

None. Read-only; audit-exempt.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/get`
- MCP tool `get_agent`
- Agent: the in-app assistant finds it with `search_tools` and loads it with `load_tools`. Low risk, no approval.
- CLI `oxagen agent status <agent>`

## Errors

| code | meaning |
|---|---|
| `not_found` | No live agent with that id or slug in the workspace (`reason: agent_not_found`). |
| `authz_denied` | No authenticated principal, or no org or workspace scope. |
