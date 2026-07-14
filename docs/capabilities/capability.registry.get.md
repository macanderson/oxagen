# capability.registry.get

Read one typed capability contract from the live registry as the full enforced object — the accountability chain made inspectable: identity (default role grants + fallback effect), knowledge scope (tenancy + audit target), permitted action (description, mode, surfaces, input/output field specs derived from the zod schemas at read time), commercial terms (billing gate + entitlement pack), and chaining metadata. Returns `capability: null` for an unknown name.

## Mode
**sync**

## Surfaces
- API: `GET /v1/capability/registry/get?name=<capability>`
- MCP: `get_capability_registry`
- Agent: callable (no approval required, risk: low)
- App: org → Governance → Capabilities catalog (contract drawer)

## Access
Governance-level. Default roles: org `Owner`/`Admin`/`Compliance` and workspace `Owner`. Sensitivity: **low**. `noBillingGate`. Declares an audit target (`capability` / `name`), so every inspection records which contract was read — the chain applied to itself.

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Capability name to look up (ADR-025 snake_case, e.g. `query_audit_log`) |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `capability` | CapabilityDetail \| null | Full contract detail, or null when no capability has that name |

`CapabilityDetail` extends the [list](capability.registry.list.md) summary with: `inputFields[]` / `outputFields[]` (`{ name, type, required, description }` derived from the contract's zod schemas), `auditTargetIdField`, `produces[]`, `consumes[]`, and `chainHints[]`.

## Related
- [capability.registry.list](capability.registry.list.md) — the filterable catalog listing.
