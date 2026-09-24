# attach_gitlab_project

Connect one gitlab.com project to the workspace with a project access token (#3762).

A GitLab token is not a GitHub App installation, so GitLab has its own connect step. `bind_main_repository` with `{ provider: "gitlab", projectPath }` then binds the project this call connected, and every Context PR, check and merge on it goes through the token stored here.

The call proves three things before it stores anything:

1. GitLab accepts the token, and reports it active and not revoked.
2. The token carries the `api` scope, which merge requests and commit statuses need, and no administrative scope (`sudo`, `admin_mode`, `create_runner`, `manage_runner`).
3. The token belongs to this project. GitLab gives each project access token a bot user named `project_<id>_bot…`. A personal token, a group token, or another project's token is refused, because each reaches more than this project.

The token and a new webhook secret are envelope-encrypted into one `ingestion.auth_credentials` row on a `source_connections` row with `connector_id = 'gitlab'`. Neither secret is returned or logged. Connecting the same project again replaces the token on the existing connection and keeps the webhook and its secret.

Oxagen then registers a project webhook for merge request events at `/webhooks/gitlab/<connection>`, signed with the webhook secret. Registering needs the Maintainer role. A token below it still connects, and `webhook.status` reads `refused`.

Disconnecting is `delete_connection`. Steering refuses from that moment, because every GitLab read joins the live connection. Revoke the token on GitLab as well.

Self-managed GitLab is not supported. Every call goes to gitlab.com until a host setting and an outbound-network review exist.

**Surfaces:** api

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/gitlab/attach` → 200
- App: Repositories page, the GitLab project form ("Connect and bind"), which calls this and then `bind_main_repository`
- MCP: none. A token must not pass through an MCP client's transcript
- CLI: none
- Authentication: session; org Owner or Admin, checked by the handler (INV-29)
- Capability name: `attach_gitlab_project`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `projectPath` | string | `group/project` or `group/subgroup/project` on gitlab.com |
| `token` | string | a project access token for that project, 20 to 255 characters, no whitespace |

## Output

| Field | Type | Description |
|---|---|---|
| `connectionId` | string | `con_…`, the workspace's GitLab connection for the project |
| `projectId` | string | GitLab's numeric project id, which the binding pins |
| `fullName` | string | `group/sub/project` as GitLab reports it |
| `defaultRef` | string | the project's default branch, which a bind approves |
| `tokenExpiresAt` | string \| null | when GitLab expires the token |
| `rotated` | boolean | true when this call replaced the token on an existing connection |
| `webhook.status` | `registered` \| `refused` \| `unchanged` | whether GitLab now delivers merge request events |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `conflict` | `invalid_project_path` | the path is not a gitlab.com project path |
| `conflict` | `gitlab_token_invalid` | GitLab does not accept the token, or reports it revoked or expired |
| `conflict` | `gitlab_token_scope` | the token lacks `api`, or carries an administrative scope |
| `conflict` | `gitlab_token_not_project_scoped` | the token is not a project access token for this project |
| `not_found` | `repository_not_found` | the token cannot see the project |
| `conflict` | `repository_archived`, `repository_empty` | the project is archived, or has no default branch |

No refusal names anything about the token.
