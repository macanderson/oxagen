# link_repository

Propose linking a GitHub repository to the workspace. The link follows the merge of a steering PR (ADR-212, ADR-099).

A workspace has one steering repository, the one whose `.oxagen/` holds its steering record. It can link any number of code repositories: the ones its agents work on. The steering record's `.oxagen/workspace.toml` lists them, so this write writes no binding head. It opens a steering PR on the steering repository that adds the repository to `workspace.toml`. When that PR merges, the steering sync reads the new file and writes the `role = 'linked'` binding head. Until then the repository is not linked.

The repository is named by `owner/name` and nothing else. The installation is the one attached to the workspace's GitHub connection, never the caller's choice. An installation id a caller could choose would let one tenant mint tokens for another account's installation.

One code repository can be linked to many workspaces, in the same organization or not. Each workspace lists it in its own `workspace.toml`, and each gets its own head.

**Surfaces:** api, mcp, agent, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/link` → 202
- MCP: `link_repository`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: `oxagen repo link <owner/name> [--json]`
- Authentication: session or API key. The handler admits an org Owner or Admin, or the workspace's Owner (INV-29).
- Capability name: `link_repository`
- Not billed (`noBillingGate: true`). IAM default-deny. Medium sensitivity.
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: medium`).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `provider` | `"github"` | no | defaults to `github`, the only provider |
| `owner` | string | yes | a GitHub login |
| `name` | string | yes | a GitHub repository name |

## Output

| Field | Type | Description |
|---|---|---|
| `fullName` | string | `owner/name` as GitHub reports it |
| `defaultRef` | string | GitHub's default branch. The sync records it as the binding's configured ref. |
| `status` | `"proposed"` or `"listed"` | `proposed`: a steering PR adds the repository. `listed`: `workspace.toml` lists it already, so no PR was opened and the next steering sync links it. |
| `steeringPullRequest` | object or null | `{ number, url, reused }` for the steering PR, or null when `status` is `listed`. `reused` is true when an open PR from the same branch already carried the change. |

## How it works

1. The handler checks the caller's role.
2. It runs the checks the sync applies when it writes the head: the installation, the repository, another workspace's steering claim, and this workspace's heads. A steering PR that could never take effect is refused before it is opened.
3. It reads `workspace.toml` on the steering repository's production branch.
   - The file lists the repository: `status: listed`, no PR.
   - The file is missing: the steering PR creates it with this one entry.
   - The file reads as `workspace/v1`: the steering PR appends the entry.
   - The file names another schema, or names `workspace/v1` and does not read against it: `conflict: workspace_toml_unreadable`. The handler does not overwrite a file it cannot read.
4. It opens the steering PR from `workspace/link-<owner>-<name>-<hash>`. A second call for the same repository reuses the branch and the open PR.

When the steering PR merges, the push to the production branch triggers the steering sync. The sync compares the new `workspace.toml` with the one it last synced. An entry that appears gets a head. An entry that goes away loses its head. Running the sync again at the same commit changes nothing.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user, or the caller is not an org Owner or Admin or the workspace's Owner |
| `conflict` | `github_not_connected` | the workspace has no GitHub connection carrying an installation |
| `not_found` | `repository_not_installed` | the installation cannot see the repository |
| `conflict` | `main_repo_claimed` | the repository is another workspace's steering repository |
| `conflict` | `main_repo_unbound` | this workspace has no steering repository to hold `workspace.toml` |
| `conflict` | `main_repo` | the repository is this workspace's steering repository |
| `conflict` | `repository_already_linked` | this workspace already links it |
| `conflict` | `main_repo_plane_unsupported` | a dedicated Postgres plane is in use, so the cross-workspace claim cannot be checked (ADR-042) |
| `conflict` | `workspace_toml_unreadable` | `workspace.toml` on the production branch cannot be read as `workspace/v1` |
| `not_found` | `workspace_not_found` | the file is missing and the workspace or its organization no longer exists |
| `conflict` | `github_refused` | GitHub refused a read, the branch, the file, or the pull request |

The reason codes that name `main_repo` keep their names because the contract fixes them. They refer to the steering repository.

`main_repo_claimed` is deliberate. Another workspace's steering repository holds that workspace's steering records. Linking it here would hand this workspace a door into those records. A linked code repository receives no Context PR, because every record lives in the steering repository (ADR-212). The refusal names neither the organization nor the workspace holding the claim, because the read that finds it crosses tenants. The store's trigger `repository_binding_heads_exclusive_main` checks it a second time when the sync writes the head.

## What this write does not do

It writes no binding head. The steering sync writes it after the merge. The §11.4 follow-through (subscribe the App to events, import issues, build the code graph) is not part of this write. The v2 descriptor at `packages/oxagen/src/contracts/v2/link-repository.ts` carries that target shape until its cutover, and ADR-099 records the deferral.
