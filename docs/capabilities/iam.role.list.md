# iam.role.list

List the org's IAM roles with their capability grants (`allow` / `deny` / `require_approval`) and the number of principals actively assigned to each. Read-only — the human-readable face of the permitted-action link of the accountability chain. Role and grant writes remain provisioning-script-only (`db:seed-iam` / `db:backfill-iam`) until dedicated write contracts are authored (ship-read-first). Powers the org Governance → Policies roles table.

## Mode
**sync**

## Surfaces
- API: `GET /v1/iam/roles/list`
- MCP: `list_iam_roles`
- Agent: callable (no approval required, risk: low)
- App: org → Governance → Policies

## Access
Admin-level. Default roles: org `Owner`/`Admin`/`Compliance`. Sensitivity: **medium** (reveals the org's permission model). `noBillingGate`. Tenant isolation is enforced in the handler — every underlying query filters by the caller's `orgId`.

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

Each `RoleRow` carries: `id` (public `rol_…` id), `name`, `description`, `scopeKind`, `isSystemDefault`, `version`, `memberCount` (active, non-expired assignments), and `grants[]` (`{ capability, effect }`, empty when `includeGrants=false`).
