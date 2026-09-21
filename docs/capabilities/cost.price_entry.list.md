# list_price_entries

The price book as the active organization reads it (Mission Control spec §12.2, App. A.7; ADR-060 §1): every provider list price effective at an instant and the organization's own negotiated rows, which win over the list row for the same model and token class. A cost record names the entry ids it was priced with, so a figure can always be traced to the price behind it.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/cost/price-entries`
- MCP: `list_price_entries`
- CLI: `oxagen price list [--at <instant>] [--include-scheduled]`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `list_price_entries`
- Not billed (`noBillingGate: true`). IAM default-deny; low sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `at` | string | no | RFC 3339; the read instant when omitted |
| `includeScheduled` | boolean | no | Also return this organization's future negotiated rows. Omitted or false retains the effective-at-instant read |

## Output

| Field | Type | Description |
|---|---|---|
| `at` | string | the instant the entries are effective at |
| `entries` | object[] | ordered by provider, model, token class, latest `effectiveFrom` first |

An entry:

| Field | Type | Description |
|---|---|---|
| `id` | uuid | what a cost record's `priceEntryIds` names |
| `orgId` | uuid or null | null for a list price every organization reads |
| `provider`, `model`, `modelAliases`, `region` | | the model the entry prices; a versioned id resolves to the longest prefix over `model` and `modelAliases` |
| `tokenClass` | enum | `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`, `server_tool_request`, `embedding_input`, `rerank`, `image`, `video_second` |
| `unit` | enum | `token`, `request`, `image`, `second` |
| `currency` | string | ISO 4217 |
| `microsPerMillion` | string | integer micro-units per one million units: $3.00 per 1M tokens is `"3000000"` |
| `effectiveFrom`, `effectiveTo` | string, string or null | the entry is effective over `[effectiveFrom, effectiveTo)`; null `effectiveTo` is open |
| `source` | enum | `list` (written by `pnpm billing:price-book-sync` from `packages/billing/src/pricing.ts`), `negotiated`, `override` |

## Tenancy

RLS on `cost.price_entries` is the `tenant_isolation` policy, which for this table is org-or-global (`org_id IS NULL OR org_id = <the session's org>`): a tenant session reads the rows with a null `org_id` and its own; a negotiated row for another organization is never returned.

## Scheduled rates

The Pricing tab opts into scheduled rows and groups them by their future start time. Each group renders up to 100 rows per page. Remove sends an authenticated opaque cancellation token for the selected row to `remove_price_entry`, which cancels only that future row and restores the preceding rate until the next scheduled row, if any.
