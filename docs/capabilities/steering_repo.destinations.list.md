# list_steering_repo_destinations

List the places where Oxagen can create a new workspace's steering repo (#5196).

A place is a GitHub organization, the owner's own personal GitHub account, or a GitLab group. The create forms call this before [create_workspace](workspace.create.md), so a person can choose the place and see the default repository name. The list comes from the same code the provisioning job's `pick_connection` step runs. A place this read offers is one the job accepts.

**Surfaces:** api, mcp, agent

## Mode

**sync**

## Surface

- API: `GET /v1/:org_slug/steering-repo/destinations?slug=<workspace slug>` returns 200. The route is mounted org-only, like `POST /v1/:org_slug/workspaces`, because the caller may have no workspace yet.
- MCP: `list_steering_repo_destinations`
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It needs no approval (`riskLevel: low`).
- CLI: none
- Authentication: org Owner or Admin, or the Owner of the workspace the call is scoped to, checked by the handler (INV-29). These are the people `create_workspace` admits.
- Not billed (`noBillingGate: true`), IAM default-deny, medium sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `slug` | string, optional | the new workspace's slug, in the shared workspace-slug shape. With it, the read names the default repository name |

## Output

| Field | Type | Description |
|---|---|---|
| `destinations` | `{ provider, id, name, kind }[]` | every place the organization's stored tokens reach, GitHub first. `id` is the GitHub installation id or the GitLab group id. `kind` is `user` for a personal GitHub account and `organization` otherwise. Empty when nothing is connected |
| `default` | `{ provider, id, name, kind }` or null | the organization's stored GitHub organization or GitLab group, where a workspace goes when the caller names none. Null before one is stored |
| `defaultName` | string or null | the repository name the slug gets by default: `oxagen-<slug>`, or `oxagen-config-2` for the `config` workspace. Null with no slug |
| `reauthorize` | `("github" \| "gitlab")[]` | hosts that refused the stored token. Their places are missing from `destinations`, and an organization owner must authorize Oxagen on that host again |

## Where the places come from

- **GitHub:** each installation of the Oxagen GitHub App that the owner's stored user token can list. An installation on an organization counts. An installation on a personal account counts only when it is the account of the person whose token is stored, because GitHub creates a repository there only with that person's token (#4899).
- **GitLab:** each group with a stored group access token.

The read calls each host's API, so it costs a few requests. A host that refuses the stored token is listed in `reauthorize`, and the other host's places still come back. Any other host failure fails the read.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user or API key creator, or the caller is not an org Owner or Admin or the workspace's Owner |
| `invalid_input` | | the slug does not fit the shared workspace-slug shape |
