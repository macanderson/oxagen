# repository.production_branch.set

Confirm or change the production branch of one of the workspace's repositories (MC spec §10.1, §11.4).

The production branch is the only branch whose commits update the code graph, the only one `.oxagen/` is read from, and the only one a Context PR merges into. GitHub's default branch is the suggestion. A person decides. `bind_main_repository` re-approves whatever GitHub's default is today, which is the confirm half. This is the change half: any branch that exists on GitHub, named by the caller.

The handler reads the branch through the workspace's installation and, when it differs from what the binding records, writes a successor binding version carrying it and moves the head onto that version, in one transaction under the workspace's repository lock. Binding versions are immutable, so runs admitted against the old branch keep citing it. Naming the branch the binding already records writes nothing and answers `changed: false`.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/production-branch` → 200
- MCP: `set_production_branch`
- CLI: `oxagen repo branch <bindingId> <branch> [--json]`
- App: the repository dialog on the Repositories page, "Make <branch> the production branch" or "Set production branch"
- Authentication: session or API key. The main repository's branch takes an org Owner or Admin; a linked repository's also admits the workspace Owner. Checked by the handler (INV-29)
- Capability name: `set_production_branch`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | yes | `rpb_…`, as `list_repositories` answered it |
| `branch` | string | yes | a branch name git accepts: no spaces, no `..`, no leading `-`, no trailing `/` or `.lock` |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the binding the head points at now; the successor when `changed` |
| `fullName` | string | `owner/name` as GitHub reports it |
| `productionBranch` | string | the branch now recorded |
| `previousBranch` | string | the branch recorded before |
| `changed` | boolean | false when the branch was already the production branch |
| `setAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user, or the roles above are missing |
| `not_found` | `repository_not_linked` | no head in this workspace carries the binding |
| `conflict` | `github_not_connected` | the workspace has no installation to read through |
| `not_found` | `repository_not_installed` | the installation cannot see the repository, or it was re-created under the same name |
| `not_found` | `branch_not_found` | GitHub has no branch by that name |
