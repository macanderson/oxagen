# get_agent

**Capability:** `get_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp, agent, cli
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

One agent identity in one read (MC spec §6.2, App. E; #2956): the identity, every long-lived credential it has held, the roles on its principal, the hosts enrolled under its agent key, and the definition of record the last `commit_agent_definition` cached. The read behind the Agents detail page's identity, definition and enrollment tabs and the CLI's `oxagen agent status`.

The identity lives in Postgres and the definition in git (ADR-057 decision 1): `definition` is the newest `agent.agent_versions` row that carries a commit — path, digest, commit, branch, pull request and the file text as committed — or `null` when the agent has no committed definition. No secret leaves this read: a credential shows its prefix and dates, a host its device-key fingerprint; the contract test refuses any output field named like a secret, a hash or a key.

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
| `definition` | object \| null | `version`, `path`, `digest` (sha256 hex), `commitSha`, `branch`, `pullRequestUrl`, `source`, `committedAt`. |

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
