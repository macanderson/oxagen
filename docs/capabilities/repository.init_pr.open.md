# repository.init_pr.open

Add Oxagen to one of the workspace's repositories by opening a pull request that puts the `.oxagen/` tree there (MC spec §10.2; the init wizard on the Repositories page).

It is the only write that can run against a repository Oxagen has never written to, and it still writes only to a branch: `oxagen/init`, cut from the production branch, with one pull request back into it. Nothing reaches the production branch until a person merges that pull request on GitHub.

The pull request carries six files: `.oxagen/workspace.toml` and `.oxagen/rules/governance.toml` as the caller reviewed them, `.gitkeep` files that hold `.oxagen/rules/`, `.oxagen/proposals/` and `.oxagen/agents/`, and `.gitignore` with the machine-local `.oxagen/workspace.json` and `.stella/private/` added when missing. `governance.toml` is the one file nothing else in the product writes, so its text is checked before anything is pushed: it must parse and declare exactly the mode the caller chose. Nothing in the tree grants an agent authority.

Idempotent: an init pull request already open for the repository is answered as it is (`reused: true`) and nothing is pushed.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/init-pr` → 201
- MCP: `open_init_pr`
- CLI: `oxagen repo init <bindingId> --workspace-toml <file> [--mode solo|team|regulated] [--governance-toml <file>] [--json]`
- App: "Add Oxagen to a repository" on the Repositories page, the five-step init wizard
- Authentication: session or API key; org Owner or Admin, checked by the handler
- Capability name: `open_init_pr`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | yes | `rpb_…`, as `list_repositories` answered it |
| `governanceMode` | `solo`, `team`, `regulated` | yes | the mode `governance.toml` must declare |
| `workspaceToml` | string | yes | 1 to 64,000 characters of TOML |
| `governanceToml` | string | yes | 1 to 16,000 characters of TOML |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the binding written to |
| `fullName` | string | `owner/name` |
| `branch` | `"oxagen/init"` | the branch the pull request comes from |
| `base` | string | the production branch it merges into |
| `pullRequest` | object | `{ number, htmlUrl }` |
| `files` | string[] | every path pushed; empty when `reused` |
| `reused` | boolean | true when an init pull request was already open |
| `openedAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user, or not an org Owner or Admin |
| `conflict` | `governance_toml_invalid` | the file does not parse, or declares a different mode |
| `conflict` | `workspace_toml_invalid` | the file does not parse |
| `conflict` | `secret_found` | a file carries a credential token, a private key block, a value after a sensitive key, an email address, a social security number or a card number; the message names the file and the finding (`secret_pii_scan`) |
| `conflict` | `authority_declared` | a file carries a grant-shaped key (`tools`, `budget`, `tier`, `permissions`, `mandate`, and the like) at any depth; the message names the file and the dotted key (`no_authority`) |
| `not_found` | `repository_not_linked` | no head in this workspace carries the binding |
| `conflict` | `github_not_connected` | the workspace has no installation to write through |
| `not_found` | `repository_not_installed` | the installation cannot see the repository |
| `conflict` | `production_branch_missing` | the production branch is gone from GitHub |
| `conflict` | `production_branch_is_init_branch` | the production branch is `oxagen/init`, so the push would land on it |
| `conflict` | `oxagen_tree_exists` | the repository already has `.oxagen/`; change it with an ordinary pull request |
| `conflict` | `github_refused` | GitHub refused a push or the pull request, with GitHub's own message |
