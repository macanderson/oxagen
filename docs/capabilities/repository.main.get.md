# get_main_repository

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
| `repository.provider` | `"github"` \| `"gitlab"` | the host the main repository is on (#3762) |
| `repository.htmlUrl` | string | `https://github.com/{fullName}` or `https://gitlab.com/{fullName}`, derived because the bind persists no html url |
| `repository.boundAt` | string | RFC 3339 |
| `repository.connectionLive` | boolean | the GitHub connection this binding hangs off is still live — not soft-deleted, and not left at `status = 'deleting'` by `delete_connection` for a purge that has not run yet. False is what a delete-then-reconnect leaves behind: the attach only ever sees live rows, so it inserts a NEW connection while the binding head still points at the retired one, and `readGitHubConnection` (the steering seam) — which joins head → binding → connection and filters exactly those statuses — resolves nothing from that moment, so steering and Context PRs are off with the repository still reading as bound. The repository is still reported, because the person has to be told which one it is; `bind_main_repository` on the SAME repository is the repair |
| `github.connected` | boolean | an installation is attached; false is exactly the state `bind_main_repository` answers `conflict: github_not_connected` in |
| `github.connectUrl` | string \| null | CONNECT — the identity leg: GitHub's user-authorization URL (`login/oauth/authorize`) carrying the API's HMAC-signed state naming this org and workspace. It always round-trips a fresh `code` and our state, installed or not, so it is the door for an account that already carries the App somewhere; the callback exchanges the code, asks `GET /user/installations` what that person reaches, and attaches what it finds. It never returns an `installation_id`, so it cannot by itself put the App on an account that lacks it |
| `github.installUrl` | string \| null | INSTALL — `installations/new`, SIGNED with the same state. The first-run door: the account carries the App nowhere, so `/user/installations` has nothing to find and the identity leg alone would loop. Signed, not bare — the bare form round-trips nothing, so the callback took its no-state branch, attached nothing, and dropped the person on the app root at `/?github_installed=1` with the workspace still unconnected (#3254) |
| `github.manageUrl` | string \| null | MANAGE — the App's configuration page for an installation already attached: change which repositories it reaches, or install it on a further account. Unsigned on purpose, because it starts no flow and carries nothing back; never the way to establish a connection |

A false `repository.connectionLive` is the one state in this output that asks for an action on a workspace that already binds a repository. The Workspace settings dialog draws it as an explanation and a Reconnect action rather than the usual "this cannot be changed here" note, and that action re-binds the same repository: the bind supersedes the binding onto the live connection and moves the head with it. Moving to a DIFFERENT repository is unchanged — `conflict: main_repo_bound`, an org owner's decision recorded as a security event (spec §10.1).

All three URLs are null together, and only when the COMPLETE set needed to finish a connect is present are they non-null: `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_INSTALL_STATE_SECRET` mint the connect URL, `GITHUB_APP_SLUG` with that secret mints the install and manage URLs, `GITHUB_APP_CLIENT_SECRET` is what the public callback exchanges the returned `code` with — without it the callback answers 503 and the operator is stranded on GitHub with nothing on our side to explain why — and `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` sign the installation token every step AFTER the connect runs on. The last two are the reason "finish its round trip" means the whole flow and not the redirect: a deployment holding the OAuth half and not the App's signing half mints a working Connect URL, completes OAuth, reports the installation attached, and then throws on every `list_installation_repositories` and every `bind_main_repository` — stranding the operator past the point of no return, which is worse than refusing at the door. These vars are independently optional in the env registry, so a deployment can hold some and not others. A deployment missing any of them still renders the dialog rather than erroring — the repository already bound is worth showing where nobody can install anything.

**The install door is signed, and the manage door is not.** They address the same GitHub page and are not interchangeable. Until #3254 the dialog offered the unsigned one as the way to install, so a first-ever install — the primary first-run path for every new customer — round-tripped no state: the callback could not attribute it to a workspace, took its no-state branch, attached nothing, and left the person on the app root. What still comes back on the signed install leg depends on the App's "request user authorization (OAuth) during installation" setting, which is external configuration: with it, GitHub returns `code` + state + `installation_id` and the callback verifies the id against the authorizing user's own `/user/installations` before attaching (`&github=connected`); without it there is no `code`, nothing can testify that this person reaches that installation, so nothing is attached and the redirect says `&github=authorize` — the dialog then names the connect door, which finishes the job in one click.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
