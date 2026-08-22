# eval.dataset.get

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Fetch one eval dataset by public id, together with a page of its items
(input, expected output, and metadata). Paginated via `limit` + `cursor` so a
large dataset's items are never loaded unbounded in a single call. Read-only
— no AI tokens spent.

## Input

| Field             | Type      | Default  | Notes                                                                 |
| ----------------- | --------- | -------- | ---------------------------------------------------------------------- |
| `datasetPublicId` | `string`  | required | Public id of the dataset to fetch                                    |
| `limit`           | `integer` | `50`     | Page size (1–200)                                                     |
| `cursor`          | `string?` | undefined| Opaque cursor — the public id of the last item on the previous page  |

## Output

| Field    | Type            | Notes                                                                     |
| -------- | --------------- | ---------------------------------------------------------------------------- |
| `dataset`| `object`        | Dataset header: `datasetId`, `name`, `slug`, `description` (nullable), `source` (`"manual" \| "traces"`), `itemCount`, `createdAt` |
| `items`  | `array of objects` | This page's items: `itemId`, `input`, `expectedOutput` (nullable), `metadata` (record) |
| `nextCursor` | `string \| null` | Cursor to pass as `cursor` for the next page, or null when exhausted |

## Side effects

None — read-only.

## Errors

None explicitly defined in the contract.
