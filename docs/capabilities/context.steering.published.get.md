# context.steering.published.get

Returns the published `.oxagen/` tree with every file's text, so `oxagen pull` can write the steering in force into a directory on your machine.

Steering is published when a Context PR merges onto the main repository's production branch (ADR-061). The steering in force is whatever that branch holds under `.oxagen/` now. This read fetches it from GitHub through the workspace's own App installation at the moment of the call. The tree and every file are read at one commit, `head`, so a push that lands mid-read cannot mix two commits into one answer. A machine needs no git access to the main repository to receive its workspace's steering.

Omit `bindingId` to read the workspace's main repository, because its `.oxagen/` is the one that steers the workspace. Pass a binding id from `list_repositories` to read another bound repository. `.oxagen/workspace.json` is never returned: it is a machine's link to its workspace and is gitignored.

A production branch GitHub no longer has answers `head: null` and no files, as `get_repository_tree` does. A tree with more than 500 files under `.oxagen/` is refused, not cut, because a partial pull would write a steering set nobody published.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/published` → 200; the body may be `{}`
- MCP: `get_published_steering`
- CLI: `oxagen pull`
- Authentication: session or API key; org Owner or Admin, or a workspace Owner, Admin, or Member
- Capability name: `get_published_steering`
- Not billed (`noBillingGate: true`); IAM default-deny; low sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | no | `rpb_…`, as `list_repositories` answered it; omitted, the main repository answers |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the binding read |
| `role` | `"main"` or `"linked"` | the repository's role in this workspace |
| `fullName` | string | `owner/name` as the binding recorded it |
| `productionBranch` | string | the branch the binding records, the only one `.oxagen/` is read from |
| `head` | string or null | the production branch's head commit; null when the branch is gone |
| `files` | array | `{ path, content }` for every file under `.oxagen/` at `head` except `workspace.json`, sorted by path |
| `readAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `conflict` | `main_repo_unbound` | no `bindingId` was given and the workspace has no main repository |
| `not_found` | `repository_not_linked` | no head in this workspace carries the binding |
| `conflict` | `github_not_connected` | the workspace has no installation to read through |
| `not_found` | `repository_not_installed` | the installation can no longer see the repository, or the repository at those coordinates is not the one the binding was made against |
| `conflict` | `repository_host_unsupported` | the repository is a GitLab project; this capability reads through a GitHub App installation and has no GitLab implementation yet (#3762) |
| `conflict` | `steering_too_large` | the tree holds more than 500 files under `.oxagen/` |
