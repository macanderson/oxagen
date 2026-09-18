# repository.link

Link a GitHub repository to the workspace as a linked repository (MC spec §10.1; the §17 M0 acceptance test "a second repo can be linked and unlinked"; ADR-099).

A workspace has exactly one main repository, the one whose `.oxagen/` steers it, bound when the workspace is created (`create_workspace`). It has any number of linked repositories: the ones its agents work on. This write adds one of the latter. The repository is named by `owner/name` and nothing else. The installation is the one attached to the workspace's GitHub connection, never the caller's choice, for the reason `bind_main_repository` gives: an installation id a caller could choose would let one tenant mint tokens for another account's installation. The handler reads the repository through that installation's token and writes, in one transaction under the workspace's repository lock, a repository binding and a `role = 'linked'` binding head (`ingestion.repository_bindings` / `repository_binding_heads`).

A repository this connection bound before, linked, unlinked and now linked again, already holds a binding version. The writer reuses it when nothing it records has moved and writes version + 1 when something has, so the unique index on (connection, repository, version) is never violated and the earlier version stays as the evidence it is.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/link` → 201
- MCP: `link_repository`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: `oxagen repo link <owner/name> [--json]`
- Authentication: session or API key; org Owner or Admin, or the workspace's Owner, checked by the handler (INV-29)
- Capability name: `link_repository`
- Not billed (`noBillingGate: true`); IAM default-deny; medium sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `provider` | `"github"` | no | defaults to `github`, the only provider |
| `owner` | string | yes | a GitHub login, the same shape `bind_main_repository` takes |
| `name` | string | yes | a GitHub repository name, the same shape `bind_main_repository` takes |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | `rpb_…`, the binding version the new head points at; what `unlink_repository` takes |
| `connectionId` | string | `con_…`, the workspace's GitHub connection |
| `fullName` | string | `owner/name` as GitHub reports it |
| `defaultRef` | string | GitHub's default branch, recorded as the binding's configured ref |
| `role` | `"linked"` | always `linked`; the main repository has its own door |
| `linkedAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user; not an org Owner or Admin or the workspace's Owner |
| `conflict` | `github_not_connected` | the workspace has no GitHub connection carrying an installation |
| `not_found` | `repository_not_installed` | the installation cannot see the repository |
| `conflict` | `main_repo_claimed` | the repository is another workspace's main repository |
| `conflict` | `main_repo` | the repository is this workspace's main repository, already bound |
| `conflict` | `repository_already_linked` | this workspace already links it |
| `conflict` | `main_repo_plane_unsupported` | a dedicated Postgres plane is in use, so the cross-workspace claim cannot be checked (ADR-042) |

`main_repo_claimed` is deliberate. §10.1 opens repository-scoped Context PRs on the linked repository itself, and another workspace's main repository holds that workspace's `.oxagen/` governance tree. Linking it here would hand this workspace a door into that tree. A repository that is nobody's main may be linked by any number of workspaces, in the same organization or not. The refusal names neither the organization nor the workspace holding the claim, because the read that finds it crosses tenants.

## What this write does not do

The §11.4 follow-through (subscribe the App to events, import issues, build the code graph) is not part of this write. The v2 descriptor at `packages/oxagen/src/contracts/v2/link-repository.ts` carries that target shape until its cutover; ADR-099 records the deferral.
