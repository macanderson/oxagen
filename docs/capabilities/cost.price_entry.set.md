# set_price_entry

Set this organization's **negotiated** rate for one model and token class (Mission Control spec §12.2, App. A.7; ADR-060 §1). A negotiated row carries the organization's own `orgId` and wins over the list row for the same model and token class, so from `effectiveFrom` on, every frame that resolves to this model and class is priced at the contracted rate rather than the provider's published one.

The row a new rate supersedes is **closed, never overwritten**: `effective_to` is set to the new `effectiveFrom` and the old row stays readable at the price it charged, because a cost record names the entry ids it was priced with and must still resolve them. A correction is always a later row — a backdated write under an open row is refused.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/cost/price-entries/set` (not `PUT`: a body that omits `effectiveFrom` takes the write instant, so a blind retry opens a second window rather than repeating the first write)
- MCP: `set_price_entry`
- CLI: `oxagen price set --provider <p> --model <m> --token-class <c> --usd-per-million <usd>`
- Authentication: session or API key (org Owner, Admin or Billing only; an API key acts as its creator)
- Capability name: `set_price_entry`
- Not billed (`noBillingGate: true`). IAM default-deny; **high** sensitivity.

## Atomic cards

`additionalRates` adds other token classes for the same provider and model. All classes share the aliases and effective instant. The writer locks the classes in sorted order, then commits every row in one Postgres transaction. A failure rolls back the whole card. A concurrent rollup reads the complete old card until commit and the complete new card afterward.

The Pricing dialog submits one card per call. CLI callers use repeatable `--additional-rate output=15` flags. Existing calls without additional rates keep their input and output shape. This choice preserves immediate pricing without a future activation delay or a separate repricing path (#3323).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `provider` | string | yes | 1–128 chars, e.g. `anthropic` |
| `model` | string | yes | 1–256 chars; the canonical model id the frame reports |
| `tokenClass` | enum | yes | `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning`, `server_tool_request`, `embedding_input`, `rerank`, `image`, `video_second` |
| `usdPerMillion` | number | yes | ≥ 0, ≤ 1,000,000 — USD per one million units, as the contract reads it (`2.40`, not `2400000`); recorded to the nearest micro-USD |
| `additionalRates` | array | no | 1 to 10 objects with distinct `tokenClass` and `usdPerMillion`; cannot repeat the primary class |
| `region` | string or null | no | null (default) is the region-agnostic row |
| `modelAliases` | string[] | no | up to 32; extra ids the rate also prices; replaces the stored list |
| `effectiveFrom` | string | no | RFC 3339; the write instant when omitted. Never earlier than the open row's |

The `unit` is derived from the token class (`token`, `request`, `image` or `second`) — a rate card names the class, never the unit — and `currency` is `USD`, because the store records micro-USD.

## Output

| Field | Type | Description |
|---|---|---|
| `entry` | object | the row now in effect for the key, in the `cost.price_entry.list` entry shape |
| `additionalEntries` | array, optional | each additional class's `entry` and `closed`, in input order; present only for a card |
| `closed` | object or null | the row this write closed at `effectiveFrom`, or null when nothing was open for the key or the write corrected a row that had not shipped yet |

## Errors

| Condition | Result |
|---|---|
| Caller is not an org Owner, Admin or Billing member | `forbidden` / `org_role_required` |
| API key whose creator is deleted, of another org, or unrecorded | `forbidden` / `no_principal` |
| `effectiveFrom` earlier than a row already effective for the key | `conflict` / `price_entry_superseded` — a correction must not start earlier |
| `effectiveFrom` names a row this organization has already ended | `conflict` / `price_entry_already_ended` — re-establish it as a new row with a later `effectiveFrom`, rather than silently un-ending a window that has already been billed |
| `effectiveFrom` names a row whose window has already begun, with different terms | `conflict` / `price_entry_already_effective` — the row has priced runs whose cost records name it; state the correction as a later row. The same terms again is a no-op |
| A first rate for the key whose `effectiveFrom` is more than five minutes before the write instant | `conflict` / `price_entry_starts_in_past` — a start in the past wins over the list price for settled frames; start it now or later |
| The model or an alias resolves to the same model as a live negotiated row under a different `model` | `conflict` / `price_entry_alias_conflict` — the resolver treats a model, its aliases and the bare family behind a `creator/` prefix as one identity, so `vendor/foo` and `foo` are one rate; end the other one first. Two models that merely share a stem stay distinct, since the family is spelled exactly |
| The model and class are already negotiated under a **different** `provider` string | `conflict` / `price_entry_provider_conflict` — the resolver never reads a frame's provider, so two providers' rows for one model would both match every call and the newer would win globally; end the other rate first |
| `region` given | `conflict` / `price_entry_region_unsupported` — frames do not carry the region they were served from, so a regional row would apply everywhere |

**Retries.** The write is idempotent on its row key, and the key includes `effectiveFrom`. A call that omits `effectiveFrom` takes the write instant, so a retry after a lost response opens another window rather than repeating the first call. A caller that wants a safe retry states `effectiveFrom` once and reuses it; the MCP tool is annotated non-idempotent for this reason.

One provider per negotiated model and class is a rule of the store, not of the table: the unique index keys on `provider`, but `resolvePriceEntry` matches on `model` and `model_aliases` alone. Every negotiated write and removal for one organization's (model, class, region) takes the same transaction-scoped advisory lock, so two writes, or a write and a removal, cannot interleave and leave the key with two open windows.

## Audit

Emits `billing.plan_changed` (SOC 2 CC6.3) — the taxonomy's "this organization's commercial terms moved" event, the same one `set_org_billing_terms` emits. The structured log carries the previous price beside the new one so an auditor can reconstruct the change.

## Tenancy

The write runs through `withTenantDb` in the caller's scope, with the organization written into the query predicate as well as into the RLS policy on `cost.price_entries` — a stack with RLS enforcement off runs the query under `app.rls_bypass`. `price_entries_org_source_check` (`(source = 'list') = (org_id IS NULL)`) means a negotiated row with a null `org_id` is refused by the table itself: this capability can never write a platform list price.
