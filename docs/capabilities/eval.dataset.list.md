# eval.dataset.list

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List the active workspace's eval datasets with their item counts, source
(`manual` cases added via `eval.dataset.item.add` vs. `traces` captured via
`eval.dataset.from_traces`), and creation timestamps. Read-only — no AI
tokens spent.

## Input

| Field | Type | Notes                |
| ----- | ---- | -------------------- |
| —     | —    | No input fields; the workspace scope alone determines the result set |

## Output

| Field      | Type                        | Notes                                                                       |
| ---------- | --------------------------- | ---------------------------------------------------------------------------- |
| `datasets` | `array of objects`          | One entry per dataset in the workspace                                     |
| `.datasetId` | `string`                  | Internal UUID                                                              |
| `.name`    | `string`                    | Display name                                                               |
| `.slug`    | `string`                    | Dataset slug                                                               |
| `.description` | `string \| null`       | Free-text description, or null                                            |
| `.source`  | `"manual" \| "traces"`      | How the dataset's items were populated                                     |
| `.itemCount` | `integer`                 | Current number of items in the dataset                                    |
| `.createdAt` | `string`                  | ISO timestamp                                                              |

## Side effects

None — read-only.

## Errors

None explicitly defined in the contract.
