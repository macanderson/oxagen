# list_workspaces

**Domain:** workspace
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the workspaces inside an organization the authenticated user belongs to. Backs the CLI workspace picker in `oxagen init`: at link time the user has chosen an org (via `org.list`) but not yet a workspace. The handler verifies the caller is a member of the org before listing — a non-member gets a not-a-member error, never another tenant's workspaces.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgSlug` | `string` | Slug of the organization whose workspaces to list. |
| `includeArchived` | `boolean` | Also list archived workspaces (`archive_workspace`). Default `false`: the switcher and the CLI picker leave archived rows out; the Organization › Workspaces section asks for them. |

## Output

| Field | Type | Notes |
|---|---|---|
| `organization` | `object` | The resolved organization. |
| `organization.id` | `string` | Internal UUID. |
| `organization.publicId` | `string` | Prefixed public identifier. |
| `organization.slug` | `string` | Org slug (renameable). |
| `organization.namespace` | `string` | Immutable, globally-unique org handle (first `agentKey` segment). |
| `organization.name` | `string` | Org display name. |
| `organization.avatarUrl` | `string \| null` | The org's avatar: an https image link or a designed-avatar string (`avatar:v1:<json>`). `null` when it has none. |
| `workspaces` | `WorkspaceListItem[]` | The org's workspaces the caller can use. |
| `workspaces[].id` | `string` | Internal UUID. |
| `workspaces[].archivedAt` | `string \| null` | ISO-8601 when the workspace was archived; `null` while active. |
| `workspaces[].publicId` | `string` | Prefixed public identifier. |
| `workspaces[].slug` | `string` | Workspace slug (renameable). |
| `workspaces[].namespace` | `string` | Immutable handle, unique within the org (middle `agentKey` segment). |
| `workspaces[].name` | `string` | Workspace display name. |
| `workspaces[].avatarUrl` | `string \| null` | The workspace's avatar: an https image link or a designed-avatar string (`avatar:v1:<json>`). `null` when it has none. |
| `workspaces[].role` | `string \| null` | The caller's workspace role, or null when they are an org admin without a direct workspace membership. |
| `workspaces[].costCenter` | `string \| null` | The cost-center label this workspace's spend is charged back to (`set_cost_center`). `null` when it names none. |

## Roles

Org: Owner, Admin, Billing, Compliance. Workspace: Owner, Member, Viewer. These are every role a person can hold. The handler lists workspaces only in an org the caller belongs to.

## Side effects

None (read-only). Reads org membership and workspaces from Postgres.

## Errors

| code | meaning |
|---|---|
| `forbidden` (reason `not_a_member`) | The caller is not a member of the organization, or no organization matches `orgSlug`. Both get the same refusal, so the answer does not reveal which slugs exist. |
