# eval.dataset.item.add

**Domain:** eval
**Mode:** batch
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Bulk-add cases to an existing eval dataset. Batch by design — one call
inserts many items (1 to 1000) as a single set and bumps the dataset's item
count in one write, rather than a round trip per item.

## Input

| Field             | Type              | Notes                                                                  |
| ----------------- | ----------------- | ------------------------------------------------------------------------ |
| `datasetPublicId` | `string`          | Public id of the target dataset (min 1 char)                            |
| `items`           | `array of objects`| 1–1000 items. Each item: `input` (string, the prompt/question handed to the target), `expectedOutput` (string, optional — the known-good answer the judge scores against when present), `metadata` (record, defaults to `{}` — free-form provenance) |

## Output

| Field       | Type      | Notes                                              |
| ----------- | --------- | --------------------------------------------------- |
| `datasetId` | `string`  | Internal UUID of the dataset                       |
| `added`     | `integer` | Number of items inserted by this call              |
| `itemCount` | `integer` | Dataset's new total item count after the insert    |

## Side effects

New rows in Postgres (eval dataset items table). The parent dataset's item
count is incremented. No AI tokens spent — `noBillingGate`.

## Errors

None explicitly defined in the contract.
