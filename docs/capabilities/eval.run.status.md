# eval.run.status

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Poll an eval run's lifecycle: status, progress counts, and mean score once
available. A cheap header read for a run started via `eval.run.start` — use
`eval.run.get` when per-item detail (individual outputs, judge scores,
tokens, cost) is needed.

## Input

| Field         | Type     | Notes                    |
| ------------- | -------- | -------------------------- |
| `runPublicId` | `string` | Public id of the eval run (min 1 char) |

## Output

| Field            | Type                                                                          | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `runId`          | `string`                                                                      | Internal UUID of the run                                                    |
| `status`         | `"pending" \| "queued" \| "running" \| "completed" \| "failed" \| "cancelled"`| Current lifecycle state                                                     |
| `itemCount`      | `integer`                                                                     | Total items scheduled for this run                                          |
| `completedCount` | `integer`                                                                     | Items scored so far                                                         |
| `failedCount`    | `integer`                                                                     | Items that errored out                                                      |
| `avgScore`       | `number \| null`                                                              | Mean judge score across completed items; null until at least one completes  |
| `failureReason`  | `string \| null`                                                              | Reason the run failed, when `status` is `"failed"`; otherwise null          |

## Side effects

None — read-only.

## Errors

None explicitly defined in the contract.
