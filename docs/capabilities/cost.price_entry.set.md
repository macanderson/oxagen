# cost.price_entry.set

Set this organization's **negotiated** rate for one model and token class (Mission Control spec §12.2, App. A.7; ADR-060 §1). A negotiated row carries the organization's own `orgId` and wins over the list row for the same model and token class, so from `effectiveFrom` on, every frame that resolves to this model and class is priced at the contracted rate rather than the provider's published one.

The row a new rate supersedes is **closed, never overwritten**: `effective_to` is set to the new `effectiveFrom` and the old row stays readable at the price it charged, because a cost record names the entry ids it was priced with and must still resolve them. A correction is always a later row — a backdated write under an open row is refused.

## Mode

**sync**

## Surface

- API: `PUT /v1/:org_slug/:workspace_slug/cost/price-entries`
- MCP: `set_price_entry`
- CLI: `oxagen price set --provider <p> --model <m> --token-class <c> --usd-per-million <usd>`
- Authentication: session or API key (org Owner, Admin or Billing only; an API key acts as its creator)
- Capability name: `set_price_entry`
- Not billed (`noBillingGate: true`). IAM default-deny; **high** sensitivity.

## Why one token class per call

A negotiated contract usually names several classes at once, so a whole-card input is the shape a human has in front of them. It is not the shape the store can honour: `cost.price_entries` holds one row per (provider, model, token class, region, `effective_from`), each effective-dated on its own, and the writer upserts one row per statement. A four-class card would be four statements, and a failure after the second would leave the organization priced at a blend — negotiated input, list output — that nobody agreed to and that nothing in the book would flag. One class per call keeps the capability atomic on exactly the row the resolver later picks. A whole card is a loop with one `effectiveFrom` for every class; `oxagen price set` is that loop's one step.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `provider` | string | yes | 1–128 chars, e.g. `anthropic` |
| `model` | string | yes | 1–256 chars; the canonical model id the frame reports |
| `tokenClass` | enum | yes | `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`, `server_tool_request`, `embedding_input`, `rerank`, `image`, `video_second` |
| `usdPerMillion` | number | yes | ≥ 0, ≤ 1,000,000 — USD per one million units, as the contract reads it (`2.40`, not `2400000`); recorded to the nearest micro-USD |
| `region` | string or null | no | null (default) is the region-agnostic row |
| `modelAliases` | string[] | no | up to 32; extra ids the rate also prices; replaces the stored list |
| `effectiveFrom` | string | no | RFC 3339; the write instant when omitted. Never earlier than the open row's |

The `unit` is derived from the token class (`token`, `request`, `image` or `second`) — a rate card names the class, never the unit — and `currency` is `USD`, because the store records micro-USD.

## Output

| Field | Type | Description |
|---|---|---|
| `entry` | object | the row now in effect for the key, in the `cost.price_entry.list` entry shape |
| `closed` | object or null | the row this write closed at `effectiveFrom`, or null when nothing was open for the key or the write corrected a row that had not shipped yet |

## Errors

| Condition | Result |
|---|---|
| Caller is not an org Owner, Admin or Billing member | `forbidden` / `org_role_required` |
| API key whose creator is deleted, of another org, or unrecorded | `forbidden` / `no_principal` |
| `effectiveFrom` earlier than a row already effective for the key | `RangeError` — a correction must not start earlier |
| `effectiveFrom` names a row this organization has already ended | `RangeError` — re-establish it as a new row with a later `effectiveFrom`, rather than silently un-ending a window that has already been billed |

## Audit

Emits `billing.plan_changed` (SOC 2 CC6.3) — the taxonomy's "this organization's commercial terms moved" event, the same one `set_org_billing_terms` emits. The structured log carries the previous price beside the new one so an auditor can reconstruct the change.

## Tenancy

The write runs through `withTenantDb` in the caller's scope, with the organization written into the query predicate as well as into the RLS policy on `cost.price_entries` — a stack with RLS enforcement off runs the query under `app.rls_bypass`. `price_entries_org_source_check` (`(source = 'list') = (org_id IS NULL)`) means a negotiated row with a null `org_id` is refused by the table itself: this capability can never write a platform list price.
