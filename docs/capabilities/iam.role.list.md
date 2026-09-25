# list_iam_roles

List the org's IAM roles with their capability grants (`allow` / `deny` / `require_approval`), the catalogue permissions those grants cover, who created each role, and the number of principals actively assigned to each — with the permission catalogue the editor speaks and whether the kernel enforces roles for the org's tier (ADR-063). Read-only: `create_role`, `set_role_grants` and `delete_role` are the writes. Powers the Organization › Roles page.

## Mode
**sync**

## Surfaces
- API: `GET /v1/iam/roles/list`
- MCP: `list_iam_roles`
- Agent: callable (no approval required, risk: low)
- App: Organization › Roles (`/{org}/roles`)

## Access
Admin-level. Default roles: org `Owner`/`Admin`/`Compliance`. The handler asserts those roles itself (INV-29), because the kernel's IAM check admits every capability for a non-enterprise organization; any other caller, an API key's creator included, is refused `forbidden`. Sensitivity: **medium** (reveals the org's permission model). `noBillingGate`. Tenant isolation is enforced in the handler — every underlying query filters by the caller's `orgId`.

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `scopeKind` | `"org" \| "workspace"` | no | Filter to roles of one scope kind (default: both) |
| `includeGrants` | boolean | no | Include each role's capability grant list; default `true` |
| `limit` | number | no | Max roles 1–200; default `100` |
| `offset` | number | no | Pagination offset; default `0` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `roles` | RoleRow[] | Roles sorted system-defaults-first, then by name |
| `total` | number | Total roles matching the filter before pagination |
| `hasMore` | boolean | Whether more roles exist beyond this page |
| `limit` | number | Echoed page size |
| `offset` | number | Echoed offset |
| `catalog` | PermissionCatalogEntry[] | The permission catalogue in catalogue order: `{ id, group, description, capabilities[] }`, seven groups (Runs, Agents, Tools and policy, Repository, Graph and steering, Money, Audit) |
| `enforcement` | `{ tier, enforced }` | `enforced` is true when the kernel's IAM check runs the resolver for this org (the enterprise tier); false when every capability is allowed for the org and the roles listed are documentation |

Each `RoleRow` carries: `id` (public `rol_…` id), `name`, `description`, `scopeKind`, `kind` (`human` for the seeded membership roles; `agent` for the seeded agent roles and every custom role, which only `assign_agent_role` binds), `isSystemDefault`, `version`, `memberCount` (active, non-expired assignments), `grants[]` (`{ capability, effect }`, empty when `includeGrants=false`), `permissions[]` (catalogue ids every capability of which the role allows — a partial cover is not the permission; empty when `includeGrants=false`), `createdAt` and `createdBy` (the creator's display name for a custom role; `null` for a system role, which the page shows as built-in).
