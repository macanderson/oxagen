# cost.unpriced_model.list

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
| `since` | string | no | RFC 3339; the start of the window model calls are counted over. The last 30 days when omitted |
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
| `calls` | number | model calls seen in the window |
| `tokens` | number | total tokens across every class, the figure the list is ranked by |
| `firstSeen`, `lastSeen` | string | RFC 3339; when the model first and last ran in the window |
| `missingClasses` | enum[] | the token classes with no effective price entry, out of `input_uncached`, `cache_read`, `cache_write_5m` and `output`. `cache_write_1h` and `reasoning` are not required: a provider with no one-hour cache tier and no separately-metered reasoning tokens is not missing a price |
| `fullyUnpriced` | boolean | true when the book prices none of the classes, so the run has no cost at all; false when some classes are priced, which the rollup records as `estimated` rather than unpriced |

At most 500 models are returned, the heaviest first: an organization running more distinct model ids than that has a naming problem, not a pricing one.

## Tenancy

The frame read is fenced on `org_id` in both stores, and on `workspace_id` as well when the caller's scope names a real workspace — the org-only mount's nil sentinel means the whole organization, not a workspace whose id is nil. The price book is read the way `loadPriceBook` reads it for the rollup: the list rows plus this organization's own negotiated rows, and never another organization's.
