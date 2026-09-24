# create_workspace

Create a workspace in the caller's organization together with its main repository, which is required (MC spec §10.1, the §17 M0 acceptance test "a workspace cannot be created without a main repo"; ADR-099).

A workspace owns its own membership roster, its default tool registry and its slug. The slug is unique within the organization and forms the second segment of every URL (`/:org_slug/:workspace_slug/...`). It also owns exactly one main repository: the one whose `.oxagen/` tree steers it. The handler writes the workspace, its GitHub connection, the version-1 repository binding and its `role = 'main'` head in one transaction. A creation that cannot bind writes nothing.

The caller names the repository, never an installation. The workspace does not exist yet, so it has no GitHub connection to take an installation from. The organization's stored GitHub authorization does exist (`ingestion.oauth_accounts` is keyed by org), so the installation is the one `GET /user/installations` answers for that authorization on the repository's owner account, matched case-insensitively. This is the reachability rule `attach_github_installation` applies. An installation id the caller could choose would let one tenant mint tokens for another account's installation, so there is no such field.

A gitlab.com main project (#3762) needs no GitHub authorization. `mainRepo: { provider: "gitlab", projectPath, token }` carries a project access token, which the handler verifies exactly as [`attach_gitlab_project`](repository.gitlab.attach.md) does, then writes a GitLab connection holding the token encrypted instead of a GitHub one, and registers the project webhook as the transaction's last step. The GitLab arm is accepted only from the web app or the HTTP API outside a chat turn. MCP, a runner, and the in-app agent are refused with `conflict: gitlab_token_surface`, because their tool input lands in a transcript, and the MCP tool offers the GitHub arm only.

**Surfaces:** api, mcp, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/workspaces` and the org-only mount `POST /v1/:org_slug/workspaces` → 201
- MCP: `create_workspace`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: none
- Authentication: session or API key; org Owner or Admin, or the Owner of the workspace the call is scoped to, checked by the handler (INV-29)
- Capability name: `create_workspace`
- Not billed (`noBillingGate: true`: a settings write, never a governed action, ADR-052 exclusion 2); IAM default-deny; medium sensitivity; `agent.requiresApproval: true`

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | 1 to 120 characters |
| `slug` | string | yes | the shared workspace-slug shape (`packages/oxagen/src/workspace-slug.ts`): lowercase letters, digits, hyphens; reserved org-route segments refused |
| `mainRepo.provider` | `"github"` \| `"gitlab"` | no | defaults to `github` |
| `mainRepo.owner` | string | GitHub | a GitHub login, the same shape `bind_main_repository` takes |
| `mainRepo.name` | string | GitHub | a GitHub repository name, the same shape `bind_main_repository` takes |
| `mainRepo.projectPath` | string | GitLab | `group/project` or `group/subgroup/project` on gitlab.com |
| `mainRepo.token` | string | GitLab | a project access token for that project; stored encrypted, never returned |

## Output

| Field | Type | Description |
|---|---|---|
| `publicId` | string | `wrk_…` |
| `name` | string | the stored name |
| `slug` | string | the reserved slug |
| `orgSlug` | string | for client-side routing |
| `createdAt` | string | RFC 3339 |
| `mainRepo.bindingId` | string | `rpb_…`, the version-1 binding the main head points at |
| `mainRepo.connectionId` | string | `con_…`, the GitHub or GitLab connection written with the workspace |
| `mainRepo.provider` | `"github"` \| `"gitlab"` | the host the main repository is on |
| `mainRepo.fullName` | string | `owner/name` (GitHub) or `group/sub/project` (GitLab) as the host reports it |
| `mainRepo.defaultRef` | string | GitHub's default branch at creation, recorded as the binding's configured ref; `bind_main_repository`'s re-approval is how it later moves |

## Side effects

One Postgres transaction: `workspace.workspaces`, `workspace.workspace_users` (the caller as owner), the workspace's default tool registry, `ingestion.source_connections` (GitHub, `connected`, the installation attached, the org's OAuth account linked), `ingestion.repository_bindings` version 1 and its `repository_binding_heads` row with `role = 'main'`. A `workspace.created` security event is recorded after the commit.

## Routes and the context they carry

`create_workspace` is scoped, so the kernel enters a tenant scope and asserts both ids are uuids. The org-only mount therefore carries `ORG_ONLY_WORKSPACE_ID` (`@oxagen/oxagen`) as its workspace id, the same constant `apps/app`'s kernel seam uses for an organization-level call; an empty string is refused with a `TenantScopeError` before the handler runs, which the API answers 400 `invalid_tenant_scope` (#3029).

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal` | no signed-in user, and no API key with a live creator |
| `forbidden` | `org_role_required` | the acting user holds none of the accepted roles |
| `not_found` | `org_not_found` | the org row the context names is missing |
| `conflict` | `slug_taken` | the slug collides within the org (the pre-check, or the unique index on a race) |
| `conflict` | `github_not_authorized` | the organization has no usable GitHub authorization; connect GitHub from an existing workspace's settings first |
| `not_found` | `installation_unreachable` | the GitHub App is not installed on the repository's owner, or the organization's authorization cannot reach that installation |
| `not_found` | `repository_not_installed` | the installation cannot see the repository |
| `conflict` | `main_repo_claimed` | another workspace already steers by that repository |
| `conflict` | `repository_linked_elsewhere` | another workspace has linked that repository; a repository that receives one workspace's Context PRs cannot hold another's `.oxagen/` governance tree |
| `conflict` | `main_repo_plane_unsupported` | a dedicated Postgres plane is in use, so the cross-workspace claim cannot be checked (ADR-042) |
| `conflict` | `gitlab_token_surface` | a GitLab main project sent from MCP, a runner, or the in-app agent's chat turn |
| `conflict` | `invalid_project_path`, `gitlab_token_invalid`, `gitlab_token_scope`, `gitlab_token_not_project_scoped`, `repository_archived`, `repository_empty` | the GitLab token or project fails the checks `attach_gitlab_project` applies |
| `not_found` | `repository_not_found` | the GitLab token cannot see the project |
| `invalid_input` | | the slug or the repository name fails the contract's validator (kernel) |

The GitHub reads run before the transaction opens, so every refusal above writes nothing. `main_repo_claimed` and `repository_linked_elsewhere` are checked twice: once by a cross-tenant read for the sentence, and once by the store. The global unique index `repository_binding_heads_main_repository_uq` on (provider, repository) where `role = 'main'` holds main against main, and the trigger `repository_binding_heads_exclusive_main` serialises every head write for one repository on a repository-keyed advisory lock and refuses a main head where another workspace holds any head for the repository. Both turn a lost race into the same refusal. Neither refusal names the organization or the workspace holding the repository.

## The one workspace written without a main repository

`create_org` writes the organization's first workspace without a main repository. That is the spec's own exception (MC spec §7, line 222): onboarding binds the main repo in a later step through the installer, and a workspace that skips it is provisional for 14 days, with steering, records and agent definitions off until `bind_main_repository` closes the window. Every other workspace comes through this capability and has its main head from its first instant.

## SPEC references

- §4.2, URL structure
- §4.4, slug uniqueness within the organization
- §10.1, one main repo, any number of linked repos
- §17 M0, a workspace cannot be created without a main repo
