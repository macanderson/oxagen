# eval.run.list

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List eval runs for the workspace (optionally scoped to one dataset) with
server-side date/status/model filtering, sorting, and pagination — the read
that backs a sortable, paginated eval-runs table. Run summaries come from
Postgres; per-run cost and token totals are rolled up from the ClickHouse
metering pipe (defaulting to zero if that pipe is unavailable, so the list
always returns).

## Input

| Field             | Type      | Notes                                                                 |
| ----------------- | --------- | --------------------------------------------------------------------- |
| `datasetPublicId` | `string?` | Restrict to one dataset (its public id); omit for all workspace runs  |
| `since`           | `string?` | ISO datetime — only runs created at/after this instant                |
| `until`           | `string?` | ISO datetime — only runs created at/before this instant               |
| `status`          | `enum?`   | `pending \| queued \| running \| completed \| failed \| cancelled`    |
| `model`           | `string?` | Only runs whose target model (`target->>'model'`) matches exactly     |
| `sortBy`          | `enum`    | `score \| created \| model \| status` (default `created`)             |
| `sortDir`         | `enum`    | `asc \| desc` (default `desc`)                                         |
| `limit`           | `integer` | Page size, 1–100 (default 25)                                         |
| `offset`          | `integer` | Page offset, ≥ 0 (default 0)                                          |

`score` sorted descending places unfinished runs (null `avgScore`) last.

## Output

| Field                    | Type                | Notes                                                          |
| ------------------------ | ------------------- | -------------------------------------------------------------- |
| `runs`                   | `array of objects`  | One entry per run on this page — see fields below              |
| `runs[].runId`           | `string`            | Public id of the run                                           |
| `runs[].datasetId`       | `string`            | Public id of the dataset the run scored                        |
| `runs[].datasetName`     | `string`            | Dataset display name                                           |
| `runs[].datasetSlug`     | `string`            | Dataset slug                                                   |
| `runs[].name`            | `string \| null`    | Optional run label                                             |
| `runs[].target`          | `object`            | `{ kind: "model" \| "agent", model, agentSlug }`               |
| `runs[].judgeModel`      | `string`            | Gateway model slug used as the judge                           |
| `runs[].status`          | `string`            | Current lifecycle state                                        |
| `runs[].itemCount`       | `integer`           | Total items scheduled for this run                             |
| `runs[].completedCount`  | `integer`           | Items scored so far                                            |
| `runs[].failedCount`     | `integer`           | Items that errored out                                         |
| `runs[].avgScore`        | `number \| null`    | Mean judge score across completed items                        |
| `runs[].passThreshold`   | `number`            | Score at/above which an item passes                            |
| `runs[].costUsdMicros`   | `integer`           | Rolled-up cost of the run, in millionths of a US dollar        |
| `runs[].inputTokens`     | `integer`           | Rolled-up input tokens across the run                          |
| `runs[].outputTokens`    | `integer`           | Rolled-up output tokens across the run                         |
| `runs[].createdAt`       | `string`            | ISO timestamp                                                  |
| `runs[].completedAt`     | `string \| null`    | ISO timestamp when the run finished, or null                   |
| `total`                  | `integer`           | Rows matching the filter set (ignores limit/offset)            |
| `allTimeTotal`           | `integer`           | Live runs in scope, ignoring since/until/status/model          |

## Side effects

None — read-only. Queries Postgres for the run rows and ClickHouse for the
per-run cost/token rollup.

## Errors

- `404` — `datasetPublicId` was supplied but no such dataset exists in scope.
