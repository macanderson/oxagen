# repository.main.get

What the Workspace settings dialog needs to show, and to unblock, the workspace's main repository (MC spec §10.1; #2967).

The main repo is where `.oxagen/` lives — published steering, the promotion ledger, and every agent definition. A workspace has exactly one, and until it is bound the workspace is provisional: runs record and spend counts, but steering, records and agent definitions stay off.

`bind_main_repository` is the write, and it refuses `conflict: github_not_connected` unless the workspace already carries a GitHub App installation. Nothing in the app could produce one: the install leg is an HTTP flow the API runs (`/connections/github/auth-url` → GitHub → the HMAC-verified callback), and no capability exposed it, so the only repo a person could ever bind was the git remote the enrolling host happened to report. This read closes that hole. It answers three things at once, because they are three faces of one question — "can this workspace keep its steering in git yet, and if not, what is the next click": the bound repository, whether an installation is attached, and the signed URLs that install one or change which repositories it reaches.

The installation id is deliberately NOT in the output. A caller that could name an installation could mint tokens for another account's installation, which is why the bind takes it from the connection rather than from input; shipping it to a browser would hand back the same handle by another route.

This handler makes no GitHub API call. It is a settings read that has to render while GitHub is down, and every fact it reports is already local.

**Surfaces:** api, mcp

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/repository/main` → 200
- MCP: `get_main_repository`. The MCP context carries an API key and no user, so the handler's role check refuses it (`forbidden: no_principal`) — the tool exists for parity and for a session-backed context
- CLI: none
- Authentication: session; org Owner or Admin, checked by the handler (INV-29) — the same pair the bind admits, because the install URL in this output is the first half of that write
- Capability name: `get_main_repository`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `repository` | object \| null | the bound main repo, or null while the workspace binds none |
| `repository.bindingId` | string | `rpb_…` |
| `repository.owner` | string | the owner login as GitHub reported it at bind time |
| `repository.name` | string | the repository name as GitHub reported it at bind time |
| `repository.fullName` | string | `owner/name` |
| `repository.defaultRef` | string | the branch `.oxagen/` is read from unless a context branch overrides it |
| `repository.htmlUrl` | string | `https://github.com/{fullName}` — derived, because the bind persists no html url |
| `repository.boundAt` | string | RFC 3339 |
| `github.connected` | boolean | an installation is attached; false is exactly the state `bind_main_repository` answers `conflict: github_not_connected` in |
| `github.installUrl` | string \| null | install the Oxagen GitHub App against this workspace, carrying the API's HMAC-signed state naming this org and workspace; null when the App is unconfigured for this deployment |
| `github.manageUrl` | string \| null | change which repositories the existing installation reaches; null when the App is unconfigured |

Both URLs are null together: they come from `GITHUB_APP_SLUG` and `GITHUB_APP_INSTALL_STATE_SECRET`, and a deployment missing either still renders the dialog rather than erroring — the repository already bound is worth showing where nobody can install anything.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
