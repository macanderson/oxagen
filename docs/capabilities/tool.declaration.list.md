# tool.declaration.list

**Domain:** tool
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate: true)

## Intent

List the tool declarations registered in the active workspace, each with the schema facts of its pinned active version (read-only flag, risk grade, policy group, checksum). Useful for auditing an agent's declared tool surface or diffing it against what a Stella catalog ships.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| source | `builtin` \| `custom` \| `mcp` \| `foundry` (optional) | Only return declarations from this source |
| limit | integer (1–200, default 50) | Maximum number of tools to return |
| offset | integer (default 0) | Pagination offset — number of tools to skip |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| tools | array | Ordered by slug |
| tools[].id | string | Public tool ID (`tol_…`) |
| tools[].slug | string | Workspace-unique key |
| tools[].name | string | Declared tool name |
| tools[].description | string \| null | |
| tools[].source | string | builtin \| custom \| mcp \| foundry |
| tools[].enabled | boolean | Per-workspace enable toggle |
| tools[].readOnly | boolean \| null | From the active version; null when none is pinned |
| tools[].riskGrade | string \| null | low \| medium \| high \| critical |
| tools[].policyGroup | string \| null | |
| tools[].version | integer \| null | Active version number |
| tools[].checksum | string \| null | SHA-256 hex over the canonical declaration |
| tools[].updatedAt | string (ISO 8601) | |
| total | integer | Total declarations matching the filter (for pagination) |

## Side effects

None — read-only.

## Errors

- DB errors propagated as-is.
