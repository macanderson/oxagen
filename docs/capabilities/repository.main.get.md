# repository.main.get

What the Workspace settings dialog needs to show, and to unblock, the workspace's main repository (MC spec §10.1; #2967).

The main repo is where `.oxagen/` lives — published steering, the promotion ledger, and every agent definition. A workspace has exactly one, and until it is bound the workspace is provisional: runs record and spend counts, but steering, records and agent definitions stay off.

`bind_main_repository` is the write, and it refuses `conflict: github_not_connected` unless the workspace already carries a GitHub App installation. Nothing in the app could produce one: the install leg is an HTTP flow the API runs (`/connections/github/auth-url` → GitHub → the HMAC-verified callback), and no capability exposed it, so the only repo a person could ever bind was the git remote the enrolling host happened to report. This read closes that hole. It answers three things at once, because they are three faces of one question — "can this workspace keep its steering in git yet, and if not, what is the next click": the bound repository, whether an installation is attached, and the signed URLs that connect one or change which repositories it reaches.

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
| `repository.connectionLive` | boolean | the GitHub connection this binding hangs off is still live — not soft-deleted, and not left at `status = 'deleting'` by `delete_connection` for a purge that has not run yet. False is what a delete-then-reconnect leaves behind: the attach only ever sees live rows, so it inserts a NEW connection while the binding head still points at the retired one, and `readGitHubConnection` (the steering seam) — which joins head → binding → connection and filters exactly those statuses — resolves nothing from that moment, so steering and Context PRs are off with the repository still reading as bound. The repository is still reported, because the person has to be told which one it is; `bind_main_repository` on the SAME repository is the repair |
| `github.connected` | boolean | an installation is attached; false is exactly the state `bind_main_repository` answers `conflict: github_not_connected` in |
| `github.installUrl` | string \| null | the Connect action: GitHub's user-authorization URL (`login/oauth/authorize`) carrying the API's HMAC-signed state naming this org and workspace. NOT `installations/new`, which only round-trips a `code` and our state on the FIRST install of the App on an account — with it here, a reconnect and a second workspace connecting to an account that already has the App both dead-ended at the callback's no-state branch; null when this deployment cannot complete the round trip |
| `github.manageUrl` | string \| null | change which repositories the existing installation reaches, and install it on a further account; null on the same condition as `installUrl` |

A false `repository.connectionLive` is the one state in this output that asks for an action on a workspace that already binds a repository. The Workspace settings dialog draws it as an explanation and a Reconnect action rather than the usual "this cannot be changed here" note, and that action re-binds the same repository: the bind supersedes the binding onto the live connection and moves the head with it. Moving to a DIFFERENT repository is unchanged — `conflict: main_repo_bound`, an org owner's decision recorded as a security event (spec §10.1).

Both URLs are null together, and only when the COMPLETE set needed to finish a connect is present are they non-null: `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_INSTALL_STATE_SECRET` mint the Connect URL, `GITHUB_APP_SLUG` mints the manage URL, and `GITHUB_APP_CLIENT_SECRET` is what the public callback exchanges the returned `code` with — without it the callback answers 503 and the operator is stranded on GitHub with nothing on our side to explain why. These vars are independently optional in the env registry, so a deployment can hold some and not others. A deployment missing any of them still renders the dialog rather than erroring — the repository already bound is worth showing where nobody can install anything.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
