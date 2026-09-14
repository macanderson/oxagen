# agent.definition.commit

**Capability:** `commit_agent_definition`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a definition write)

## Intent

Write an agent's definition of record to the workspace repository and open the pull request that publishes it (MC spec §6.2 "Identity in Postgres, definition in git", §10.2; ADR-057 decision 1; #2956). The definition is the file `.oxagen/agents/<slug>.toml`. The capability commits the text the caller supplies to a branch that is never the repository's default branch — the branch is created from the default branch when it does not exist — opens a pull request against the default branch, and caches the commit on a new unpublished `agent.agent_versions` row (path, digest, source, commit, branch, pull request). The running definition stays what the default branch holds until a person merges the pull request. Nothing here merges.

The handler refuses a file whose top-level `schema` is not `agent-definition/v0.1` or whose `slug` is not the agent's, and a branch equal to the binding's configured default ref or the repository's default branch. For an enterprise organization the delegation ceiling (spec §6.2: a person can grant an agent no more than they hold) is enforced on the capabilities the file's top-level `tools` names, the same resolver `assign_agent_role` runs; below enterprise the kernel's IAM allows every capability to every member, so the check is vacuous there.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | `agt_…` or slug. |
| `repositoryId` | `string?` | The repository binding (`rpb_…`). Optional when the workspace binds exactly one repository. |
| `branch` | `string` | A git branch name. |
| `source` | `string` | The file text, up to 64 KiB. |
| `message` | `string?` | Commit and pull request title; default `Agent definition: <slug>`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | |
| `version` | `number` | The `agent_versions.version` row that cached the commit. |
| `path` | `string` | `.oxagen/agents/<slug>.toml`. |
| `digest` | `string` | sha256 hex of `source`. |
| `commitSha` | `string` | |
| `branch` | `string` | |
| `pullRequest.number` / `.url` | | |

## Roles

Org Owner, Admin or Member; workspace Owner or Member. Checked by the handler (INV-29).

## Side effects

- GitHub, through the caller's repository binding: a branch (when absent), one commit, one pull request.
- Postgres: one `agent.agent_versions` row.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/definition/commit`
- MCP tool `commit_agent_definition`

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user; not one of the roles; or, for an enterprise org, the definition names tools the committer does not hold (`delegation_ceiling`). |
| `not_found` | No live agent (`agent_not_found`), or no binding with the given `repositoryId` (`repository_not_found`). |
| `conflict` | The agent is retired (`agent_retired`); the file's schema (`definition_schema`) or slug (`definition_slug`) is wrong; the workspace binds no repository (`no_repository`) or more than one without `repositoryId` (`repository_ambiguous`); the branch is the default branch (`branch_is_default`). |
