# cost.price_entry.remove

End this organization's **negotiated** rate for one model and token class (Mission Control spec §12.2, App. A.7; ADR-060 §1). From `at` on, every frame that resolves to this model and class is priced at the provider list price again.

It removes the row from the *active* book, not from the book. The row is closed — `effective_to = at` — and kept, because a cost record priced before `at` names the entry id it was priced with and must still be able to read it. Nothing here deletes history.

Nothing here touches a list row either: the platform's published price is not an organization's to change, so a key this organization never negotiated is refused rather than answered as though something had been removed.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/cost/price-entries/remove`
- MCP: `remove_price_entry`
- CLI: `oxagen price remove --provider <p> --model <m> --token-class <c>`
- Authentication: session or API key (org Owner, Admin or Billing only; an API key acts as its creator)
- Capability name: `remove_price_entry`
- Not billed (`noBillingGate: true`). IAM default-deny; **high** sensitivity.

`POST /remove` rather than `DELETE` on the collection: nothing is deleted, and the key plus the instant travel in a body, which `DELETE` carries unreliably across clients and proxies.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `provider` | string | yes | 1–128 chars, e.g. `anthropic` |
| `model` | string | yes | 1–256 chars; the canonical model id the negotiated row prices |
| `tokenClass` | enum | yes | the same eleven classes `set_price_entry` takes |
| `region` | string or null | no | null (default) is the region-agnostic row |
| `at` | string | no | RFC 3339; the write instant when omitted. Must be after the row starts |

One token class per call, for the same reason `set_price_entry` takes one: a token class is a row, each effective-dated on its own, and closing them one at a time is the only way each close is atomic. Ending a whole card is a loop with one `at`.

## Output

| Field | Type | Description |
|---|---|---|
| `at` | string | the instant the negotiated rate stopped applying |
| `closed` | object or null | the row as closed, in the `cost.price_entry.list` entry shape, or null when the organization had already ended it |

Re-ending a class this organization has already ended answers `closed: null` and changes nothing, so a retry is safe.

## Errors

| Condition | Result |
|---|---|
| Caller is not an org Owner, Admin or Billing member | `forbidden` / `org_role_required` |
| API key whose creator is deleted, of another org, or unrecorded | `forbidden` / `no_principal` |
| The key has no negotiated row for this organization | `RangeError` — it is priced by the platform list, which is not an organization's to change |
| `at` is at or before the row's `effectiveFrom` | `RangeError` — a price cannot end at or before it starts (`price_entries_effective_range_check`) |

## Audit

Emits `billing.plan_changed` (SOC 2 CC6.3), whether or not a row was open: the request to return a model to list pricing is the event.

## Tenancy

The write runs through `withTenantDb` in the caller's scope. The read admits the list rows — the same set the RLS policy on `cost.price_entries` shows a tenant session — precisely so a key priced only by the list is distinguishable from one this organization has already ended; only a row whose `org_id` is the caller's and whose `source` is not `list` is ever updated.
