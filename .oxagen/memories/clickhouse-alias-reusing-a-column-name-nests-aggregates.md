---
name: clickhouse-alias-reusing-a-column-name-nests-aggregates
type: bug
domain: runs
severity: P1
linear: "GitHub #4106"
date: 2026-09-24
---

**Symptom:** every `get_run_work` call in production answered 500 `internal_error`. The API log read `_ClickHouseError code 184: Aggregate function min(seq) AS seq is found inside another aggregate function in query.` Every Run page printed "repo not captured" and showed no subagents. `get_run_outputs` caught the same error and drew no pull request nodes.
**Root cause:** `readWorkPrLinks` in `packages/handlers/src/lib/run-work.ts` selected `min(seq) AS seq`. A ClickHouse alias applies to the whole query and wins over the column, so `argMin(ts, seq)` read `seq` as `min(seq)`. ClickHouse refuses the query before reading a row, even for an empty session.
**Fix:** alias `first_seq` and `first_ts`. `toString(ts) AS ts` and `argMaxIf(effort, ...) AS effort` in the same file worked only because each name sat inside its own definition; they are now `observed_at` and `reported_effort`.
**Guard:** `run-work.test.ts` refuses any alias in the six reads that names a `tacho_events` column (from `tachoEventsColumns()`). `run-work.clickhouse.test.ts` runs the reads on CI's migrated ClickHouse.
**Watch-outs:** every handler test mocks `chSelect` or the read itself, so SQL errors pass every unit test and reach production. A new ClickHouse read needs a test that runs on CI's ClickHouse (skip on a failed `/ping`). Never alias an aggregate with the name of a column.
