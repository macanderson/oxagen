# list_installation_repositories

The repositories the workspace's GitHub App installation can see, so a person can pick which one becomes the main repo (MC spec §10.1; #2967).

This is the picker behind `bind_main_repository`. It exists so the choice on screen and the choice the write accepts are the same set: the bind resolves the repository through the installation's token and answers `not_found: repository_not_installed` for anything that token cannot read, so a picker built from any other list (the user's own repositories, a typed `owner/name`) would offer options that refuse on submit.

Like the bind, the caller names no installation. It is taken from the workspace's GitHub connection — the one the HMAC-verified install callback attached — because an installation id a caller could choose would let one tenant enumerate another account's repositories. A workspace with no installation is `conflict: github_not_connected`, the same refusal the bind gives, which is what `get_main_repository` reports before this is called.

`truncated` is honest rather than paginated: the installation token lists repositories a page at a time and this read walks a bounded number of pages (5 × 100 = 500). An installation granted access to more repositories than that says so, and the surface tells the person to narrow the App's repository access on GitHub (`github.manageUrl`) rather than silently hiding the repository they want.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/repository/installation/repositories` → 200
- MCP: `list_installation_repositories`. The MCP context carries an API key and no user, so the handler's role check refuses it (`forbidden: no_principal`) — the tool exists for parity and for a session-backed context
- CLI: none
- Authentication: session; org Owner or Admin, checked by the handler (INV-29) — the pair that may bind
- Capability name: `list_installation_repositories`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

None. The org and workspace come from the capability context; the installation comes from the workspace's GitHub connection.

## Output

| Field | Type | Description |
|---|---|---|
| `repositories[].id` | string | GitHub's numeric repository id as text; survives renames and transfers, and is what a binding pins |
| `repositories[].owner` | string | the owner login |
| `repositories[].name` | string | the repository name |
| `repositories[].fullName` | string | `owner/name` as GitHub reports it |
| `repositories[].defaultBranch` | string | the repository's default branch |
| `repositories[].private` | boolean | visibility, so two same-named repositories are tellable apart |
| `repositories[].htmlUrl` | string | the repository on GitHub |
| `truncated` | boolean | the installation reaches more repositories than this read walked |

Repositories are sorted by `fullName`, so two reads of an unchanged installation put the same repository in the same place; GitHub's own order is not promised.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `conflict` | `github_not_connected` | the workspace has no GitHub connection carrying an installation |

A GitHub failure (a revoked installation, a rate limit) surfaces as the upstream error rather than as an empty list: an installation that reaches nothing and an installation that could not be read are different answers, and only one of them means "pick a repository".
