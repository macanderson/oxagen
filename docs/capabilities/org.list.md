# org.list

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the organizations (tenants) the authenticated user belongs to, with the caller's role in each. Backs the tenant picker — a freshly-authenticated user has no org selected yet, so this is the first call the linker makes to present the picker. The handler reads the caller's own memberships and never crosses to another user's memberships.

## Input

No input fields.

## Output

| Field | Type | Notes |
|---|---|---|
| `organizations` | `OrgListItem[]` | The orgs the caller belongs to. |
| `organizations[].id` | `string` | Internal UUID. |
| `organizations[].publicId` | `string` | Prefixed public identifier. |
| `organizations[].slug` | `string` | Org slug (renameable). |
| `organizations[].namespace` | `string` | Immutable, globally-unique org handle (first `agentKey` segment). |
| `organizations[].name` | `string` | Org display name. |
| `organizations[].role` | `string` | The caller's role in this org (lowercase, e.g. owner/admin/member). |
| `organizations[].avatarUrl` | `string \| null` | Org avatar URL, nullable. |

## Roles

Org Owner, Org Admin, Org Member, Org Billing, Org Compliance, Org Viewer.

## Side effects

None (read-only). Reads the caller's `org_users` memberships from Postgres.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not authenticated. |
