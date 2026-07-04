# workspace.list

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

## Output

| Field | Type | Notes |
|---|---|---|
| `organization` | `object` | The resolved organization. |
| `organization.id` | `string` | Internal UUID. |
| `organization.publicId` | `string` | Prefixed public identifier. |
| `organization.slug` | `string` | Org slug. |
| `organization.name` | `string` | Org display name. |
| `workspaces` | `WorkspaceListItem[]` | The org's workspaces the caller can use. |
| `workspaces[].id` | `string` | Internal UUID. |
| `workspaces[].publicId` | `string` | Prefixed public identifier. |
| `workspaces[].slug` | `string` | Workspace slug. |
| `workspaces[].name` | `string` | Workspace display name. |
| `workspaces[].role` | `string \| null` | The caller's workspace role, or null when they are an org admin without a direct workspace membership. |

## Roles

Org Owner, Org Admin, Org Member, Org Billing, Org Compliance, Org Viewer.

## Side effects

None (read-only). Reads org membership and workspaces from Postgres.

## Errors

| code | meaning |
|---|---|
| `not_found` | No organization matches `orgSlug`. |
| `unauthorized` | Caller is not a member of the organization. |
