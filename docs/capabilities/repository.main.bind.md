# bind_main_repository

Bind a GitHub repository as this workspace's main repo (MC spec App. F "Bind <repo> as the main repo (installs the GitHub App: binding, Context PRs, checks …)"; #2967), and close the onboarding gate's provisional window.

The GitHub App installation reaches the workspace through the connect flow the API already runs (`/connections/github/auth-url` → GitHub → the HMAC-verified callback), which attaches the installation id to the workspace's GitHub connection. This write names only the repository: the handler takes the installation from that connection and never from the caller, because an installation id a caller could choose would let one tenant mint tokens for another account's installation. It reads the repository through the installation's token — a repository the installation cannot see is `not_found: repository_not_installed` — and writes, in one transaction, the version-1 repository binding and its head (`ingestion.repository_bindings` / `repository_binding_heads`, the rows the run ledger pins and `commit_agent_definition` commits to), marks the connection `connected` (the row `resolveGitHubToken` mints from), and sets `org.onboarding_state.main_repo_bound_at` when the workspace is the gate's, which is what lets `publish_context_record` write again.

## GitLab

`{ provider: "gitlab", projectPath }` binds a gitlab.com project the workspace connected with [`attach_gitlab_project`](repository.gitlab.attach.md) (#3762). The handler finds the live GitLab connection for that path, reads the project by its numeric id through the connection's project access token, and writes the binding and head with `provider = 'gitlab'`. `provider_owner` is the full namespace, so a project in nested groups binds as `owner = acme/platform`, `name = rules`. The same idempotency, re-approval, repair and cross-workspace refusals apply, keyed on the provider and the project id together, so a GitLab project never collides with a GitHub repository that carries the same number. A workspace with no live GitLab connection for the path is `conflict: gitlab_not_connected`; a project the token can no longer see is `not_found: repository_not_installed`.

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
| `provider` | `"github"` \| `"gitlab"` | no | omitted means GitHub |
| `owner` | string | GitHub | a GitHub login |
| `name` | string | GitHub | a GitHub repository name |
| `projectPath` | string | GitLab | `group/project` or `group/subgroup/project` on gitlab.com |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | `rpb_…` |
| `connectionId` | string | `con_…`, the workspace's GitHub or GitLab connection |
| `provider` | `"github"` \| `"gitlab"` | the host the main repository is on |
| `fullName` | string | `owner/name` (GitHub) or `group/sub/project` (GitLab) as the host reports it |
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
| `conflict` | `main_repo_claimed` | another workspace already steers by that repository (ADR-099); names neither the organization nor the workspace holding it |
| `conflict` | `repository_linked_elsewhere` | another workspace has linked that repository; a repository that receives one workspace's Context PRs cannot hold another's `.oxagen/` governance tree |
| `conflict` | `main_repo_plane_unsupported` | a dedicated Postgres plane is in use, so the cross-workspace claim cannot be checked (ADR-042) |

`main_repo_claimed` and `repository_linked_elsewhere` are checked twice: once by a cross-tenant read before the transaction, for the sentence, and once by the store. The unique index `repository_binding_heads_main_repository_uq` holds main against main, and the trigger `repository_binding_heads_exclusive_main` serialises every head write for one repository on a repository-keyed advisory lock and refuses a main head where another workspace holds any head for it. A bind that loses that race is refused with the same reason.

`main_repo_bound` is about MAIN heads only. A repository this workspace already holds as a LINKED head is promoted in place instead: `role` moves to `main`, carrying any binding version the same call supersedes, and `boundAt` is the promotion rather than the original link. That is the way out of a workspace left with linked heads and no main one, which the exclusivity migration's demotion creates directly. It is also the only correct write there: one head per (connection, repository) is `repository_binding_heads_repository_uq` and a second version 1 for that pair is `repository_bindings_repository_version_uq`, so a writer that ignored the linked head would lose to a constraint naming no cross-workspace claim and surface as a 500. A repository with binding versions retained from an unlinked head reuses the latest version for the same reason.

Binding the same repository again is idempotent **only while nothing the binding recorded has moved**: nothing is written and the existing binding is answered, with `provisionalClosed: false`.

When any recorded fact differs from what GitHub now reports — the connection, the owner, the name, the full name, or the approved default ref — the call is a **re-approval** and writes a successor binding. All five are compared together and carried forward together, so a version can never hold a combination no single observation produced.

The approved default ref is the case that matters most in service. Steering resolves `defaultBranch` from the binding's `configured_default_ref`, and `assertProductionBase` refuses any Context PR whose base is not it — deliberately, so that renaming a repository's default branch on GitHub cannot silently retarget every Context PR at a branch nobody approved. The cost is that a rename leaves the workspace pinned to a branch that may no longer exist, and **this capability is the only thing that moves the pin**. `set_main_repository`, which `docs/specs/repository-binding/` names for changing which repository is main, has no contract and no handler. In the app, the bound panel offers the re-approval whenever the connection is live; it is unconditional rather than drift-triggered because `get_main_repository` is a pure binding read and detecting drift would put a live GitHub round trip on every settings render.

The repository's **name** is frozen by the binding for the same reason and with one consequence worth knowing before you re-approve. `provider_full_name` is dotted into the `set_id` at the top of every Context record file (`docs/specs/steering/`), so it is what groups a workspace's records into one set, and steering reads it from the binding rather than from live GitHub — a rename alone does not re-stamp later records. Re-approving after a rename does: the successor binding records the new name, and records written from then on carry the new `set_id` while the existing ones keep the old. That is the honest outcome of an owner approving a new identity, and it is the same split the production ref undergoes, but it means a rename plus a re-approval divides the set. If that matters for a given workspace, rename back before re-approving, or accept the split knowingly.

Binding the same repository again through a DIFFERENT connection is the other cause, and it writes for the same reason. That state is reached by deleting the workspace's GitHub connection and reconnecting: `delete_connection` leaves the old row at `status = 'deleting'` for a later purge, so the install callback's attach — which only ever sees live rows — inserts a new connection, and the binding head goes on pointing at the retired one. Every reader that joins the head back to its connection, `readGitHubConnection` included, then resolves nothing, so steering and Context PRs are off while `get_main_repository` still reports the repository as bound (it now says so, in `repository.connectionLive`). This write moves it: a binding is immutable, so it INSERTS the successor version (`version = previous + 1`, `supersedes_binding_id` naming the row it replaces) on the live connection and updates the head in place to point at both. The superseded binding row is left exactly as it was.

The line between the two is the repository, not the connection. Re-binding the SAME repository is a repair of the connection behind it; moving to a DIFFERENT repository is an org owner's decision recorded as a security event (spec §10.1) and still refuses with `conflict: main_repo_bound`. The repair cannot point a workspace at a repository the replacement installation cannot read, because `not_found: repository_not_installed` is checked before the transaction opens.
