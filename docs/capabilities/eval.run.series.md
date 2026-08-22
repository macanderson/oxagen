# eval.run.series

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Bucketed score-over-time series for eval runs (optionally scoped to one
dataset), plus a per-model breakdown (average score, pass rate, and its own
time series) — the read that backs score-trend and model-comparison charts.
Score only; there is no cost metric in v1. Only completed runs (those with a
non-null `avgScore`) contribute to the aggregates.

## Input

| Field             | Type      | Notes                                                                |
| ----------------- | --------- | -------------------------------------------------------------------- |
| `datasetPublicId` | `string?` | Restrict to one dataset (its public id); omit for all workspace runs |
| `since`           | `string?` | ISO datetime — only runs created at/after this instant               |
| `until`           | `string?` | ISO datetime — only runs created at/before this instant              |
| `bucket`          | `enum`    | `day \| week` time-bucket granularity (default `day`)                |

## Output

| Field                     | Type               | Notes                                                        |
| ------------------------- | ------------------ | ------------------------------------------------------------ |
| `overall`                 | `array of objects` | One entry per time bucket, ascending — see fields below      |
| `overall[].bucketStart`   | `string`           | ISO timestamp of the bucket's start                          |
| `overall[].avgScore`      | `number \| null`   | Mean run score in the bucket                                 |
| `overall[].runCount`      | `integer`          | Completed runs falling in the bucket                         |
| `byModel`                 | `array of objects` | One entry per target model — see fields below                |
| `byModel[].model`         | `string`           | Target model key (`COALESCE(model, agentSlug, 'default')`)   |
| `byModel[].vendor`        | `string`           | Vendor resolved from the model catalog (fallback: id prefix) |
| `byModel[].avgScore`      | `number \| null`   | Mean run score for the model across the range                |
| `byModel[].passRate`      | `number`           | Share of the model's runs with `avgScore >= passThreshold`   |
| `byModel[].runCount`      | `integer`          | Completed runs for the model                                 |
| `byModel[].points`        | `array of objects` | Per-bucket avg score for the model, ascending                |
| `byModel[].points[].bucketStart` | `string`    | ISO timestamp of the bucket's start                          |
| `byModel[].points[].avgScore`    | `number \| null` | Mean run score for the model in the bucket             |

## Side effects

None — read-only. Aggregates the Postgres `eval_runs` summaries; does not touch
ClickHouse.

## Errors

- `404` — `datasetPublicId` was supplied but no such dataset exists in scope.
