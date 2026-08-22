# capability.registry.list

List the platform's typed capability contracts from the live in-process registry — name, domain, surfaces, layers, sensitivity, default IAM grants, entitlement gate, and audit binding for each. Read-only platform metadata (never tenant data); the runtime counterpart of `pnpm check:manifest`. Powers the org Governance hub's "active contracts" tile and the Capability & Contract catalog.

## Mode
**sync**

## Surfaces
- API: `GET /v1/capability/registry/list`
- MCP: `list_capability_registry`
- Agent: callable (no approval required, risk: low)
- App: org → Governance → Capabilities catalog

## Access
Governance-level. Default roles: org `Owner`/`Admin`/`Compliance` and workspace `Owner`. Sensitivity: **low**. `noBillingGate` — reading contract metadata never consumes credits and is never balance-gated.

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `domain` | string | no | Exact domain filter (e.g. `billing`) |
| `q` | string | no | Case-insensitive substring match on name, domain, or description |
| `surface` | `"api" \| "mcp" \| "agent"` | no | Only capabilities exposed on this surface |
| `missingLayer` | `"schema" \| "api" \| "mcp" \| "unit" \| "e2e" \| "docs" \| "app"` | no | Only capabilities that do NOT declare this layer (surface-gap filter) |
| `sensitivity` | `"low" \| "medium" \| "high" \| "destructive"` | no | Only capabilities with this sensitivity |
| `limit` | number | no | Max rows 1–1000; default `500` |
| `offset` | number | no | Pagination offset; default `0` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `capabilities` | CapabilitySummary[] | Matching contracts, sorted by name |
| `total` | number | Total matches before pagination |
| `hasMore` | boolean | Whether more rows exist beyond this page |
| `limit` | number | Echoed page size |
| `offset` | number | Echoed offset |
| `domains` | string[] | All distinct domains in the registry (unfiltered), sorted |

Each `CapabilitySummary` carries: `name`, `domain`, `description`, `mode`, `surfaces[]`, `layers[]`, `sensitivity`, `defaultEffect`, `scoped`, `noBillingGate`, `agent` (approval/risk/category or null), `auditTargetKind`, `plugin` (entitlement pack id + tier + minPlanTier, or null), and the default `orgRoles` / `workspaceRoles` grant maps.

## Related
- [capability.registry.get](capability.registry.get.md) — one contract as the full enforced object (field specs included).
