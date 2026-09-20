# agent.propose

**Capability:** `propose_agent`
**Domain:** agent
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a definition write, ARCHITECTURE.md §1.5)

## Intent

Write an agent that does not exist yet, as a pull request against the workspace's main repository (MC spec §6.2, §10.2; roadmap creation-spec §1). The definition is the file `.oxagen/agents/<slug>.toml`. The call writes no row. It cuts the branch `agents/<slug>` from the production branch the repository binding recorded, commits the definition and the subagent file generated from it, and opens the pull request, or lands on the branch's open one. After merge, register the agent under the same slug to create its identity and credential.

This is New agent, not Register an agent. `register_agent` mints an identity for an agent that already runs on a machine or in CI. `propose_agent` writes the definition of one that does not run anywhere yet.

The generated file is `.claude/agents/<slug>.md`: the name, the description and the instructions, under a header that names the source file and its digest. Claude Code and Cursor read subagents there, and Stella adopts them from `.claude/` (ADR-101). Codex documents no subagent file, so it gets none. The generated file carries no `tools` line, because the belt is Oxagen's to enforce.

Six checks run before anything reaches GitHub, and a failed check writes nothing:

1. **Schema**: the file parses as TOML, `schema = "agent-definition/v0.1"`, `slug` matches the input, and `name`, `model_tier`, a `tools` list and `[instructions] body` are present.
2. **Key**: no agent in the workspace holds the slug, live, retired or deleted (ADR-024), and no definition is merged at the path.
3. **Belt**: every pattern in `tools` resolves. A pattern is a registry tool's slug, `slug@N` for a version the registry holds, `slug@*`, a glob, or a kernel capability named bare.
4. **Authority**: `side_effects` names only `read` and `write`, because `irreversible` needs a mandate and a new agent holds none. For an enterprise organization, every capability in `tools` is one the author holds (the delegation ceiling).
5. **Budget**: `budget.per_run_micros` is a positive whole number. An agent with no budget cannot start a run.
6. **Secret and PII scan**: the whole file is scanned for credential shapes and US social security numbers.

The checks are pure functions exported from the contract module (`checkAgentDefinition`).

## Input

| Field | Type | Notes |
|---|---|---|
| `slug` | `string` | Lowercase words joined by hyphens, up to 18 characters, as `register_agent` takes it. The file name and the last part of the agent key. |
| `harness` | `"stella" \| "claude-code" \| "codex" \| "cursor" \| "claude-agent-sdk" \| "custom"` | The harness the agent is written for. Named on the pull request body. |
| `source` | `string` | The definition bytes, up to 64 KiB. |
| `rationale` | `string?` | What the author described; quoted on the pull request. |

## Output

| Field | Type | Notes |
|---|---|---|
| `slug`, `path`, `branch` | `string` | `.oxagen/agents/<slug>.toml` on `agents/<slug>`. |
| `generatedPath` | `string \| null` | `.claude/agents/<slug>.md` for Claude Code, Cursor, and Stella. Null for other harnesses. |
| `agentKey` | `string \| null` | `org_ns.ws_ns.slug` to use when registering after merge; null while a namespace is unset. |
| `repository`, `baseRef` | `string` | The main repository and its production branch. |
| `digest` | `string` | `sha256:<hex>` of the committed definition (LF line ends). |
| `checks` | `{ name, passed, code }[]` | The six checks, all passed. |
| `commitSha` | `string` | The last commit on the branch. |
| `pullRequest.number` / `.url` | | Opened by this call, or the one already under review. |

## Roles

Org Owner or Admin, checked by the handler (INV-29) for the signed-in user. Merging the file creates a principal, which is what `register_agent` needs. An API key carries no user, so the call is refused there.

## Side effects

- GitHub, through the workspace's main repository binding: a branch when absent, two commits, one pull request when the branch has none open.
- Postgres is read, never written: the slug, the namespaces, the tool registry and the author's grants.

## Surfaces

- `POST /api/v1/{org}/{ws}/agents/propose`
- App: the agent wizard's last step (`apps/app/src/features/create`), opened from Agent IAM **New agent** and from ⌘K **Create**.

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user (`no_principal`), or the user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | The workspace binds no main repository (`workspace_repository_missing`). |
| `conflict` | A check failed (`agent_check_<name>`: `agent_check_schema`, `agent_check_key`, `agent_check_belt`, `agent_check_authority`, `agent_check_budget` or `agent_check_secrets`), or GitHub refused a write (`github_refused`). |

## Not built yet

Merging the file does not create the principal yet. No handler reads `.oxagen/agents/` from a merge commit, so after the merge the operator registers the agent with `register_agent` under the same slug.
