# eval.run.get

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Fetch an eval run's summary (from Postgres) together with its full per-item
results (from the ClickHouse metering pipe): each item's output, judge
scores, pass/fail, tokens, latency, and cost. The detail counterpart to the
cheap `eval.run.status` header read.

## Input

| Field         | Type     | Notes                    |
| ------------- | -------- | -------------------------- |
| `runPublicId` | `string` | Public id of the eval run (min 1 char) |

## Output

| Field                | Type                                                                          | Notes                                                                     |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `run`                | `object`                                                                      | Run summary — see fields below                                             |
| `run.runId`          | `string`                                                                      | Internal UUID of the run                                                    |
| `run.datasetId`      | `string`                                                                      | Internal UUID of the dataset the run scored                                 |
| `run.name`           | `string \| null`                                                              | Optional run label                                                          |
| `run.target`         | `object`                                                                      | The target evaluated — `{ kind: "model", model?, systemPrompt? }` or `{ kind: "agent", agentSlug }` |
| `run.judgeModel`     | `string`                                                                      | Gateway model slug used as the judge                                        |
| `run.passThreshold`  | `number`                                                                      | Overall judge score (0–1) at/above which an item passes                     |
| `run.status`         | `"pending" \| "queued" \| "running" \| "completed" \| "failed" \| "cancelled"`| Current lifecycle state                                                     |
| `run.itemCount`      | `integer`                                                                     | Total items scheduled for this run                                          |
| `run.completedCount` | `integer`                                                                     | Items scored so far                                                         |
| `run.failedCount`    | `integer`                                                                     | Items that errored out                                                      |
| `run.avgScore`       | `number \| null`                                                              | Mean judge score across completed items                                     |
| `run.scoreBreakdown` | `record<string, number>`                                                     | Aggregate score breakdown (e.g. mean correctness, mean faithfulness)         |
| `run.createdAt`      | `string`                                                                      | ISO timestamp                                                               |
| `results`            | `array of objects`                                                            | One entry per scored item — see fields below                               |
| `results[].itemId`         | `string`  | Dataset item id this result scored                                                       |
| `results[].targetKind`     | `string`  | `"model"` or `"agent"`                                                                    |
| `results[].model`          | `string`  | Model slug actually used for the target call                                             |
| `results[].judgeModel`     | `string`  | Model slug actually used for the judge call                                              |
| `results[].score`          | `number`  | Overall judge score (0–1)                                                                |
| `results[].correctness`    | `number`  | Agreement with the expected output (0–1)                                                 |
| `results[].faithfulness`   | `number`  | Grounding in any cited context (0–1)                                                     |
| `results[].passed`         | `boolean` | `score >= run.passThreshold`                                                             |
| `results[].latencyMs`      | `integer` | Wall-clock time for the target call                                                      |
| `results[].inputTokens`    | `integer` | Input tokens spent on the target call                                                    |
| `results[].outputTokens`   | `integer` | Output tokens spent on the target call                                                   |
| `results[].costUsdMicros`  | `integer` | Cost of the item's target + judge calls, in millionths of a US dollar                    |
| `results[].status`         | `"completed" \| "failed"` | Per-item execution status                                                |
| `results[].errorClass`     | `string`  | Error classification when `status` is `"failed"`; empty string otherwise                 |
| `results[].output`         | `string`  | The target's raw output for this item                                                    |
| `results[].rationale`      | `string`  | The judge's rationale for the score                                                       |

## Side effects

None — read-only. Queries Postgres for the run row and ClickHouse for
item-level results.

## Errors

None explicitly defined in the contract.
