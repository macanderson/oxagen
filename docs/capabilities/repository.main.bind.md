# repository.main.bind

Bind a GitHub repository as this workspace's main repo (MC spec App. F "Bind <repo> as the main repo (installs the GitHub App: binding, Context PRs, checks …)"; #2967), and close the onboarding gate's provisional window.

The GitHub App installation reaches the workspace through the connect flow the API already runs (`/connections/github/auth-url` → GitHub → the HMAC-verified callback), which attaches the installation id to the workspace's GitHub connection. This write names only the repository: the handler takes the installation from that connection and never from the caller, because an installation id a caller could choose would let one tenant mint tokens for another account's installation. It reads the repository through the installation's token — a repository the installation cannot see is `not_found: repository_not_installed` — and writes, in one transaction, the version-1 repository binding and its head (`ingestion.repository_bindings` / `repository_binding_heads`, the rows the run ledger pins and `commit_agent_definition` commits to), marks the connection `connected` (the row `resolveGitHubToken` mints from), and sets `org.onboarding_state.main_repo_bound_at` when the workspace is the gate's, which is what lets `publish_context_record` write again.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/main` → 201
- MCP: none. The MCP context carries an API key and no user, and the handler's role check refuses a context without one (`forbidden: no_principal`)
- Authentication: session; org Owner or Admin, checked by the handler (INV-29)
- Capability name: `bind_main_repository`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `owner` | string | yes | a GitHub login |
| `name` | string | yes | a GitHub repository name |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | `rpb_…` |
| `connectionId` | string | `con_…`, the workspace's GitHub connection |
| `fullName` | string | `owner/name` as GitHub reports it |
| `defaultRef` | string | the repository's default branch, pinned as the binding's configured ref |
| `boundAt` | string | RFC 3339 |
| `provisionalClosed` | boolean | true when this call closed the gate's provisional window |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `conflict` | `github_not_connected` | the workspace has no GitHub connection carrying an installation |
| `not_found` | `repository_not_installed` | the installation cannot see the repository |
| `conflict` | `main_repo_bound` | the workspace already binds a different repository |

Binding the same repository again is idempotent and answers the existing binding with `provisionalClosed: false`.
