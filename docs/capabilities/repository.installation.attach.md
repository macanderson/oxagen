# attach_github_installation

Make one of the workspace's candidate GitHub App installations the one it acts through.

This is the write behind `list_github_installations`, and the two are one decision: a person who administers several accounts that all carry the App must say which of them this workspace reaches repositories through, because `bind_main_repository` and `list_installation_repositories` both mint a token with the platform App's private key against whatever installation the workspace's GitHub connection names.

That is exactly why the id here is checked rather than trusted. An installation id names an account's source code, and the token minted through it carries no caller entitlement at all — GitHub asks who the App is, not who asked. So the id a caller supplies is matched against `GET /user/installations` answered for this workspace's own stored GitHub authorization before a single row is written, on exactly the rule the HMAC-verified install callback applies to the `installation_id` GitHub redirects with (`apps/api/src/routes/v1/github-oauth.ts`). An id that list does not carry is `not_found: installation_unreachable`, whatever else is true of it. Fail closed: a false refusal costs a click, a false acceptance costs another tenant's repositories.

It is idempotent by nature — attaching the installation a workspace already acts through rewrites the same value — and it does not unbind anything. A workspace that has already bound a main repository keeps it; moving a workspace to another repository is `bind_main_repository`'s refusal to make.

**Surfaces:** api

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/installation/attach` → 200
- MCP: none. The choice is made by a person in front of the Workspace settings dialog, immediately after a browser OAuth round trip that stored the token this write verifies against; there is no agent-shaped version of it
- CLI: none
- Authentication: session; org Owner or Admin, checked by the handler (INV-29) — the pair that may bind, because this is the first half of that write
- Capability name: `attach_github_installation`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `installationId` | string | GitHub's numeric installation id as text, as `list_github_installations` reported it. The pattern is the one `installationIdOf` accepts when the repository capabilities read it back, so a value every reader would silently skip never reaches the row — a pre-filter, not the check |

## Output

| Field | Type | Description |
|---|---|---|
| `connectionId` | string | `con_…`, the workspace's GitHub connection this installation now hangs off |
| `accountLogin` | string \| null | the account the attached installation belongs to; null when GitHub reported the installation without one |

The row written is the row `resolveWorkspaceGithubInstallation` reads: both go through the one connection predicate and both order newest-first. A workspace with no live GitHub connection gets one, at `pending_setup` rather than `connected` — `status = 'connected'` is what the ingestion poll scheduler claims, and an installation with no record-type mappings does not belong in the sync loop. `bind_main_repository` promotes it when it binds a repository.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `conflict` | `github_not_authorized` | the org has no usable GitHub authorization to verify the id against |
| `not_found` | `installation_unreachable` | the id is absent from the connected account's own `/user/installations` — including when GitHub could not be asked at all |
| `invalid` | `invalid_input` | the id is not a plain positive integer |
