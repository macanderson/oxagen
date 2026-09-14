# ADR-057: Agents: the definition of record, budgets in micros, enrollment

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** platform
- **Refines:** ADR-024 (the agent key `org_ns.ws_ns.slug` and the reserved
  slug), ADR-052 (the governed action is the billable unit; a settings or
  credential write on an identity is outside the metering surface).
- **Related:** `apps/app/ARCHITECTURE.md` §1.5, §3.2, §3.4, INV-09, INV-29;
  the Mission Control spec `2026-09-11-oxagen-mission-control-spec.md`
  §6.1–§6.3, §6.6, §10.2, App. E; GitHub issue #2956 (the Agents page);
  `packages/oxagen/src/contracts/agent.{list,get,register,credential.rotate,suspend,retire,definition.commit,toolbelt.get}.ts`,
  `packages/oxagen/src/contracts/tacho.incident.list.ts`,
  `packages/oxagen/src/contracts/billing.budget.{get,set}.ts`,
  `packages/database/atlas/migrations/20260915013000_agent_identity_and_definition_of_record.sql`,
  `packages/agent/src/runtime/toolbelt.ts`.

## Context

The Mission Control spec separates an agent into an identity in Postgres
and a definition in git (§6.2). The tree records the identity today — the
`agent.agents` row, its delegated `iam.principals` row, the host
enrollments in `tacho.hosts` — and records the definition as a row in
`agent.agent_versions`, written by `create_agent_def` and
`update_agent_def` from a JSON config. The spec (§10.2) and the mockup
("the running definition stays main's") describe `.oxagen/agents/<slug>.toml`
in the workspace repository as the file a person edits, reviews in a pull
request and merges. Issue #2956 names three decisions the page cannot be
built without:

1. Whether the definition of record is the file in git or the database row.
2. Whether `get_spend_budget` and `set_spend_budget` keep their float USD
   fields, which break INV-09 (money on the wire is integer micros in a
   string with a currency), or change shape for their API, MCP and CLI
   consumers.
3. Whether Rotate credential, Suspend and Deregister ship as writes on the
   identity tab.

The issue records a recommendation for each. This ADR adopts the three.

## Decision

### 1. Git is the definition of record; the version row caches the commit

The definition of an agent is the file `.oxagen/agents/<slug>.toml` in the
workspace's bound repository, on the repository's default branch. The
database row is a cache of what was committed, never the source.

- `commit_agent_definition` is the one write. It commits the caller's file
  text to a branch that is never the default branch (a branch equal to the
  binding's configured default ref or the repository's default branch is
  refused with `conflict`, reason `branch_is_default`), opens a pull
  request against the default branch, and inserts one unpublished
  `agent.agent_versions` row carrying `definition_path`,
  `definition_digest` (sha256 of the file), `definition_source`,
  `commit_sha`, `branch` and `pull_request_url`. Nothing in Oxagen merges
  the pull request: the running definition changes when a person merges.
- The handler checks the file's top-level `schema` is
  `agent-definition/v0.1` and its `slug` is the agent's. For an enterprise
  organisation the capabilities the file's `tools` list names are checked
  against the committer's own effective grants, the delegation ceiling
  `assign_agent_role` already enforces; below enterprise the kernel's IAM
  allows every capability to every member, so the check is vacuous there
  (ARCHITECTURE.md §1.5).
- `get_agent.definition` is the newest version row that carries a commit,
  or null. The identity row records `harness` so the identities table
  prints it for an agent with no host.
- `register_agent` writes no definition: it mints the identity — the agent
  row, its principal, the default agent role when seeded, and one
  long-lived credential returned once.
- The legacy `create/update/publish_agent_def` path keeps writing
  `config` rows with the six new columns null. It is not deleted here:
  the page lane that binds the definition tab decides what of it remains.

### 2. Budgets carry `Money`

`get_spend_budget` and `set_spend_budget` carry `{ micros, currency }` for
the ceiling (`limit`), the burn (`spent`) and the projection
(`projected`). The store has held `billing.spend_budgets.limit_micros
bigint` since the table was created and ClickHouse holds
`cost_usd_micros`; the floats `limitUsd`, `spentUsd` and `projectedUsd`
were computed on the way out and rounded sub-cent figures. The shape
changed in the zero-customer window; the API, MCP and CLI consumers in the
tree (`apps/cli/src/commands/budget.ts`, the app's spend mapper, the MCP
tool) moved in the same change and the capability docs say so. The
contract refuses a `limit` that is not a positive integer micro string in
`USD`, the currency the store records.

### 3. The identity writes ship

`rotate_agent_credential`, `suspend_agent` and `retire_agent` are the
identity tab's writes, with `register_agent` shared with onboarding.

- A credential is an `auth.api_keys` row whose scope carries the
  server-owned purpose `agent_credential_v1` bound to the agent and its
  principal (`@oxagen/oxagen/agent-credential`); `generateApiKey` mints it
  so the prefix window `@oxagen/auth` resolves is the same as for any key.
  Rotation soft-deletes every live credential and mints the replacement in
  one transaction.
- Suspension is one write to `iam.principals.status`; every run token
  fails at its next call. Resume is the same write back to `active`.
- Retirement archives the agent row, suspends the principal, soft-deletes
  the credentials and revokes every live host with the three writes
  `revoke_tacho_enrollment` makes. Nothing is deleted: runs keep the
  agent's key and principal. Retiring a retired agent, and suspending a
  suspended one, answer the recorded state without a write.
- Every write is `noBillingGate: true` (ADR-052 exclusion 2: a settings or
  credential write is not a governed action) and checks org Owner or Admin
  in the handler (`assertOrgRole`, INV-29). Each emits a security event:
  `agent.registered`, `agent.suspended`, `agent.resumed`, `agent.retired`,
  with `api_key.created` / `api_key.revoked` where a key changed.

### The belt is one decision, shared

`get_agent_toolbelt` reports the belt without executing anything, and the
decision per tool is the runtime's own: `materializeTools` and the read
both call `decideCapabilityForBelt` / `decideMcpToolForBelt`
(`packages/agent/src/runtime/toolbelt.ts`) over the same registry, the
same agent ∩ human resolution, the same entitlement read, the same MCP
rules and consent ledger and the same active emergency denies. A gate
added to one side and not the other would be a belt the record shows and
the model does not get, or the reverse; a parity test holds the two
together.

### Reads

`list_agents`, `get_agent`, `get_agent_toolbelt` and `list_incidents` are
console reads (`noBillingGate: true`, `mutates: false`, INV-28). A figure
no store records is `null` with the reason on the contract field
(`tier`, `beltSize`, `proven30d`, `mandates`, `holdingMandate`); nothing
prints a zero it did not count (ARCHITECTURE.md §3.4).

## Consequences

- An agent's definition is reviewable, diffable and revertable with the
  repository's own tools; Oxagen holds a cache and a pointer, never the
  authority.
- A workspace with no repository binding cannot commit a definition
  (`conflict`, `no_repository`); one that binds several must name one.
- Budget consumers built against the float fields break; there are none
  outside the tree.
- The `harness` CHECK and the six nullable version columns are additive;
  no existing row changes meaning.

## Alternatives considered

- **The database row as the record with a git export.** Rejected: the spec
  and the mockup make the pull request the publication step, and an export
  that the row can outrun is a second source of truth.
- **Keeping the float budget fields with a parallel micros field.** Rejected:
  two figures for one number, and INV-09 forbids the float.
- **Deleting an agent on deregister.** Rejected: runs cite the agent's key
  and principal; a retired identity keeps them citable.
