# billing.reseller_attribution_rule.save

**Name:** `save_reseller_attribution_rule`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Upsert a rule mapping a slice of observed usage (by workspace, acting principal, or capability) to a customer — the accountability edge that makes per-customer revenue possible.

## Input

`id` (rule public id, omit to create), `matchKind` (`workspace`|`principal`|`capability`), `matchValue`, `matchLabel`, `customerId`, `priority`.

## Output

`{ rule }` — resolved to its customer name.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/attribution-rules`
- **MCP:** tool `save_reseller_attribution_rule`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
