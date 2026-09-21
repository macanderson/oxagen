# remove_price_entry

End this organization's **negotiated** rate for one model and token class (Mission Control spec §12.2, App. A.7; ADR-060 §1). From `at` on, every frame that resolves to this model and class is priced at the provider list price again — when one exists. `fallbackPriced` in the output says whether it does: a model this organization negotiated alone, with no list or override row of its own, has nothing to fall back to, and the class goes unpriced rather than list-priced.

The handler checks for that fallback **before** it closes anything. When this organization has a live rate for the key and no list, override, or other negotiated row would price it once that rate ends, the call refuses with `price_entry_close_would_unprice` unless `confirmUnpriced: true` is set — closing first and reporting the gap in the output afterward would leave every frame in the meantime priced wrong, with the caller finding out only after the fact. A call with nothing live to close (never negotiated, or already ended) is unaffected: it stays the safe no-op a retry relies on.

It removes the rate from the *active* book, not from the book. The row in effect at `at` is closed — `effective_to = at` — and kept, because a cost record priced before `at` names the entry id it was priced with and must still be able to read it. A row already closed at a later instant (a scheduled correction had been written) is shortened to `at`. Nothing here deletes history.

The rate is the whole effective-dated chain for the key, so a correction **scheduled to start after `at`** does not survive the end either: it would re-establish the rate the caller just ended. One that has not begun by the write instant is cancelled — removed, since no run was ever priced against it and a row cannot end before it starts — and named in the handler's log. One that has already begun is refused: ending the rate before a window that has shipped would reprice settled runs, the same refusal a backdated write meets. End it at or after that window's start instead.

Nothing here touches a list row either: the platform's published price is not an organization's to change. A key this organization never negotiated answers `closed: null`, which claims nothing was removed.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/cost/price-entries/remove`
- MCP: `remove_price_entry`
- CLI: `oxagen price remove --provider <p> --model <m> --token-class <c> [--confirm-unpriced]`
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
| `at` | string | no | RFC 3339; the write instant when omitted. Must be after the row in effect at that instant starts |
| `confirmUnpriced` | boolean | no | required (`true`) when ending a live rate would leave the class with no fallback price; ignored otherwise |

One token class per call, for the same reason `set_price_entry` takes one: a token class is a row, each effective-dated on its own, and closing them one at a time is the only way each close is atomic. Ending a whole card is a loop with one `at`.

## Output

| Field | Type | Description |
|---|---|---|
| `at` | string | the instant the negotiated rate stopped applying |
| `closed` | object or null | the row that was in effect at `at`, as closed, in the `cost.price_entry.list` entry shape, or null when nothing was in effect at that instant |
| `fallbackPriced` | boolean | whether a list, override or other negotiated row still prices this model and class from `at` on. False means the class has no fallback and is now unpriced, not list-priced — callers must say so rather than repeat the usual "falls back to the list price" line. Resolved from the current book when `closed` is null. |

Re-ending a class this organization has already ended answers `closed: null` and changes nothing, so a retry is safe. So is a retry after a cancellation: a scheduled row that never began is deleted when it is cancelled, and the retry finds nothing and answers the same null close. A key this organization never negotiated gets that answer too.

The call takes the same per-key transaction lock `set_price_entry` takes, so a removal that overlaps a write cannot read the old state and either close a row the write is replacing or report success while the new rate stands.

## Errors

| Condition | Result |
|---|---|
| Caller is not an org Owner, Admin or Billing member | `forbidden` / `org_role_required` |
| API key whose creator is deleted, of another org, or unrecorded | `forbidden` / `no_principal` |
| The organization is on a dedicated Postgres plane | refused before the store is called — the price book is read from the shared plane only, so a close on a dedicated plane would report an end the rollup never sees; the same refusal `set_price_entry` makes |
| `at` is at or before the start of the row in effect at `at` | `conflict` / `price_entry_ends_before_it_starts` — a price cannot end at or before it starts (`price_entries_effective_range_check`) |
| A correction scheduled after `at` has already begun by the write instant | `conflict` / `price_entry_ends_before_it_starts` — ending the rate before a window that has shipped would reprice settled runs; end it at or after that window starts |
| The class has a live rate and would have no fallback price once it ends, and `confirmUnpriced` was not `true` | `conflict` / `price_entry_close_would_unprice` — set a fallback price first, or pass `confirmUnpriced: true` to end the rate anyway |

## Audit

Emits `billing.plan_changed` (SOC 2 CC6.3), whether or not a row was open: the request to return a model to list pricing is the event.

## Tenancy

The write runs through `withTenantDb` in the caller's scope and reads only the caller's rows; a list row (`org_id` null) is never read or updated. The handler refuses an organization on a dedicated Postgres plane before the store is called, because `loadPriceBook` and the rollup read the price book from the shared plane (ADR-042).

## Cancel one scheduled rate

Pass `scheduledEntryId` with the model, provider, class, and region key to cancel only that future row. Omit `at`. The transaction deletes the selected row, restores its predecessor's end to the cancelled row's previous end, and retains later scheduled rows. A missing selected row is an idempotent no-op. A row that has already started returns `price_entry_already_started`.

The store takes the negotiated class and key locks before checking the start time. If extending the predecessor would overlap another negotiated model identity, it refuses with `price_entry_alias_conflict` before changing either row. Cancellation does not remove current pricing, so it does not require `confirmUnpriced`.

CLI: `oxagen price remove --provider <provider> --model <model> --token-class <class> --scheduled-entry-id <id>`.

The app uses `cancellationToken` instead of the database ID. The management read encrypts and authenticates the row identity, organization, model key, source, and start instant under a domain-specific key derived from `BETTER_AUTH_SECRET`. The handler refuses a token for another organization or key, a changed row, or a tampered token before the store write. Key rotation invalidates existing tokens; refresh the price book to obtain a new one.
