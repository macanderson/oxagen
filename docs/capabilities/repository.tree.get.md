# repository.tree.get

What one of the workspace's repositories holds under `.oxagen/` on its production branch (MC spec §10.1, §10.2), for the Repositories page, the CLI and MCP.

The answer is read from GitHub through the workspace's own App installation at the moment of the call, never from a copy. Git decides what is in force, so a page that described `.oxagen/` from a cache would be describing the past. The production branch is the one the binding records. GitHub's current default branch comes back beside it, so a caller can see that it moved without the binding moving (§11.4: the binding never moves on its own).

A production branch GitHub no longer has answers `head: null` and an empty tree rather than a refusal. It is a fact the page must show, and the repair (`set_production_branch`) is on the same page.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/tree` → 200
- MCP: `get_repository_tree`
- CLI: `oxagen repo tree <bindingId> [--json]`
- App: the Repositories page's `.oxagen/` column, the repository dialog, and the Configuration tab
- Authentication: session or API key; org Owner or Admin, or a workspace Owner or Member
- Capability name: `get_repository_tree`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | yes | `rpb_…`, as `list_repositories` answered it |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the binding read |
| `role` | `"main"` or `"linked"` | the repository's role in this workspace |
| `fullName` | string | `owner/name` as the binding recorded it |
| `productionBranch` | string | the branch the binding records, the only one `.oxagen/` is read from |
| `githubDefaultBranch` | string | GitHub's default branch now; a suggestion, never the decision |
| `head` | string or null | the production branch's head commit; null when the branch is gone |
| `oxagen.present` | boolean | whether any path under `.oxagen/` exists at `head` |
| `oxagen.files` | string[] | every path under `.oxagen/` at `head`, sorted |
| `workspaceToml` | string or null | `.oxagen/workspace.toml` in full, when it exists |
| `governanceToml` | string or null | `.oxagen/rules/governance.toml` in full, when it exists |
| `governanceMode` | `solo`, `team`, `regulated`, `absent`, `invalid` | the mode the file declares; `absent` reads as `team`, `invalid` refuses both open and merge |
| `initPullRequest` | object or null | `{ number, htmlUrl }` of an open `oxagen/init` pull request |
| `readAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `not_found` | `repository_not_linked` | no head in this workspace carries the binding |
| `conflict` | `github_not_connected` | the workspace has no installation to read through |
| `not_found` | `repository_not_installed` | the installation can no longer see the repository |
