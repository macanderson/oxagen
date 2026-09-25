# list_unpriced_models

The models this organization is running that nobody has stated a price for (Mission Control spec §12.2, App. A.7; ADR-060 §1). A frame whose model the price book cannot price is recorded `unpriced` by the rollup — no cost, no basis, deliberately never a zero — so the run comes back with a blank cost and no explanation. This is the explanation: the model, how much of it has been run in the window, and exactly which token classes are missing a price.

Two answers close a gap. An operator of the installation states the rate in the environment, and every organization gets it. An organization with a rate it negotiated itself states it as a `negotiated` row through `set_price_entry`, which wins over the list rate for that organization and nobody else.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/cost/unpriced-models`
- MCP: `list_unpriced_models`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `list_unpriced_models`
- Not billed (`noBillingGate: true`). IAM default-deny; low sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `since` | string | no | RFC 3339; the start of the window model calls are counted over. The last 30 days when omitted. The window ends at `at`: a model first run after `at` is not reported against a book snapshot from before it ran |
| `at` | string | no | RFC 3339; the instant the price book must be effective at. The read instant when omitted, and the instant the default window is counted back from |

## Output

| Field | Type | Description |
|---|---|---|
| `since` | string | the start of the window the models were observed over |
| `at` | string | the instant the book was resolved at |
| `models` | object[] | fully unpriced models first, then by tokens run, then by model id — the model costing the most invisible money is at the top |

A model:

| Field | Type | Description |
|---|---|---|
| `model` | string | the model id as the frames report it; a gateway call and a wrapped agent's call of the same model are one row, because they need one price |
| `provider` | string or null | the vendor the frames name; null when they name none |
| `calls` | number | model calls seen in the window. A wrapped agent's call is counted once whichever token-bearing sources (OTel log, collector, hook) recorded it: per session, only the highest-authority source that reported any model call is admitted |
| `tokens` | number | total tokens across every class, the figure the list is ranked by |
| `firstSeen`, `lastSeen` | string | RFC 3339; when the model first and last ran in the window |
| `missingClasses` | enum[] | the token classes with no effective price entry covering the calls that used them, out of `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output` and `reasoning`. Every class is checked on the same footing: a class the model never sent a token in is never named here, even when the book has no row for it at all, but `cache_write_1h` and `reasoning` are checked exactly like the rest whenever the model actually used them |
| `missingClassWindows` | object[] | one entry per class in `missingClasses`, each with `tokenClass`, `unpricedFrom` and `unpricedTo`: the span of that class's unpriced calls, so the Pricing tab can say when a class went unpriced rather than only that it did |
| `fullyUnpriced` | boolean | true when every usage bucket the model actually sent tokens in came back unpriced, so the run has no cost at all. A class with both a priced and an unpriced bucket, such as a rate that lapsed and later came back, still names that class in `missingClasses`, but the model is not `fullyUnpriced`: it has real cost from the priced bucket, and the rollup records it `estimated` |

At most 500 models are returned, fully unpriced models first and then the heaviest: an organization running more distinct model ids than that has a naming problem, not a pricing one. The cap applies to the report, not to the comparison. Every model the window holds is read, a page at a time, and judged against the book before the cap is applied, so a lightly used unpriced model is reported even when thousands of heavier priced models ran beside it.

## Tenancy

The frame read is fenced on `org_id` in both stores, and on `workspace_id` as well when the caller's scope names a real workspace — the org-only mount's nil sentinel means the whole organization, not a workspace whose id is nil. The price book is read the way `loadPriceBook` reads it for the rollup: the list rows plus this organization's own negotiated rows, and never another organization's.

An observation window with `since` after `at` is refused with HTTP 409, code
`conflict`, reason `unpriced_model_window_reversed`, before usage is read.
Equal endpoints are accepted as an empty interval.
