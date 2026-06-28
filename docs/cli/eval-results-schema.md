# Eval results — storage protocol & queries

**Status:** reference · **Last reviewed:** 2026-06-28 · **Store:** ClickHouse (db `oxagen`) · **DDL:** `packages/telemetry/src/schema.sql` · **Writer:** `packages/telemetry/src/clickhouse.ts` · **Companion to:** [`eval-runbook.md`](./eval-runbook.md)

Where every Oxagen agent-eval run is saved so you can **measure the code agent improving over time** and **catch behavioral regression per task**. Eval results are append-only time-series measurements about the product itself, so they live in **ClickHouse** (the append-only telemetry store in the four-store model), not Postgres.

## Why this shape

A good eval store has to absorb metrics that don't exist yet without a migration, while still being fast to slice by the dimensions you always group on. So the protocol is: **a few typed core dimensions every harness shares + two open maps.**

- `metrics Map(String, Float64)` — any numeric measurement (`cost_usd`, `tokens`, `latency_p50_ms`, `context_precision`, `context_recall`, …). New metric → no migration.
- `labels Map(String, String)` — any string tag (`failure_signature`, `error_class`, `judge_model`, `diff_sha`, …).
- Typed columns for what you *always* filter/aggregate on: `harness`, `suite`, `agent_version`, `model`, the ablation flags, `history_depth`, and the headline outcome (`resolved_rate` / `passed`).

Two tables:

| Table | Grain | Engine | Use |
|---|---|---|---|
| **`eval_runs`** | one row per run (suite header + rollup) | `ReplacingMergeTree(updated_at)` | "did the whole suite improve over time?" — kept forever (no TTL). |
| **`eval_results`** | one row per (run, task[, repeat]) | `MergeTree` | "which **tasks** regressed?" — 365-day TTL (detail is regenerable). |

Both denormalize the slice dimensions, so each queries standalone (ClickHouse-idiomatic — no joins). `run_id` links them when you want both grains.

**Conventions (enforced by the schema):**
- `run_id` / `task_id` are `String`, never `UUID` — benchmark task ids like `gpt2-codegolf__saXZwmX` are not UUIDs, and a non-UUID string in a UUID column aborts the whole row (see the `clickhouse-execution-step-id` memo).
- All `ORDER BY` key columns are non-nullable (use sentinels / defaults, never `Nullable` on a key).
- **Not tenant-scoped** — these measure the product (CI/local/research), so there is no `org_id`. Put a tenant id in `labels` if you ever need one.
- `eval_runs` is a `ReplacingMergeTree`: write the header at run start, then **re-insert the same `run_id` finalized at the end** (later `updated_at` wins). Always read it `FINAL`.

## Writing results (the protocol)

From any TypeScript surface via `@oxagen/telemetry`:

```ts
import { insertEvalRun, insertEvalResults } from "@oxagen/telemetry/clickhouse";

// 1. header at run start (open state)
await insertEvalRun({
  run_id, run_group: "tb2-warm-curve",
  agent_name: "oxagen", agent_version: "0.6.2", model: "claude-sonnet-4.5",
  harness: "terminal-bench", suite: "terminal-bench-2.0", suite_version: "2.0",
  git_sha, git_branch: "main", environment: "ci",
  graph_code: 1, graph_exec: 1, graph_mem: 1, warm: 1, history_depth: 5, seed: 1,
});

// 2. per-task results as they finish
await insertEvalResults(tasks.map((t) => ({
  run_id, task_id: t.id, harness: "terminal-bench", suite: "terminal-bench-2.0",
  agent_name: "oxagen", agent_version: "0.6.2", model: "claude-sonnet-4.5",
  graph_code: 1, graph_exec: 1, graph_mem: 1, warm: 1, history_depth: 5,
  passed: t.resolved ? 1 : 0, reward: t.reward,
  metrics: { cost_usd: t.cost, tokens: t.tokens, turns: t.turns },
  labels: t.resolved ? {} : { failure_signature: t.failureSig },
})));

// 3. finalize the header (re-insert same run_id → replaces under FINAL)
await insertEvalRun({
  run_id, agent_name: "oxagen", agent_version: "0.6.2", model: "claude-sonnet-4.5",
  harness: "terminal-bench", suite: "terminal-bench-2.0",
  n_tasks, n_passed, resolved_rate: n_passed / n_tasks,
  metrics: { cost_usd_total, p50_latency_ms },
});
```

`metrics`/`labels` are coalesced to `{}` when omitted, so the Map columns always receive a value. Timestamps default to `now()` in ClickHouse — omit them unless backfilling.

The existing harnesses map onto this cleanly: engram `EvalMetrics` → `metrics` (`contextPrecision`→`context_precision`, …); `bench/terminal-bench` `result.json` reward → `passed`/`reward`; `bench/context-eval` warm rounds → one `eval_runs` row per round with `history_depth = round`; `bench/rag-eval` RAGAS/DeepEval scores → `metrics`.

## Canonical queries

All verified against ClickHouse 24.8. Adjust the `WHERE` to your harness/suite/cell.

### 1. Improvement over time (suite-level)
Resolved rate per agent version for a fixed ablation cell — the headline trend.
```sql
SELECT agent_version, min(started_at) AS first_run, avg(resolved_rate) AS resolved_rate,
       round(avg(metrics['cost_usd']), 2) AS cost
FROM eval_runs FINAL
WHERE harness = 'terminal-bench' AND suite = 'terminal-bench-2.0'
  AND graph_code = 1 AND graph_exec = 1 AND graph_mem = 1
GROUP BY agent_version
ORDER BY first_run;
```

### 2. Improvement *with experience* (the self-improvement learning curve)
Resolved rate as a function of accumulated memory/graph depth (runbook §7.2).
```sql
SELECT history_depth, avg(resolved_rate) AS resolved_rate, count() AS runs
FROM eval_runs FINAL
WHERE run_group = 'tb2-warm-curve' AND warm = 1
GROUP BY history_depth
ORDER BY history_depth;          -- a positive slope = self-improvement
```

### 3. Regression vs the previous version (per task)
Tasks whose pass flipped 1→0 between the two latest versions.
```sql
SELECT task_id,
       anyIf(passed, agent_version = '0.6.1') AS prev,
       anyIf(passed, agent_version = '0.6.2') AS curr,
       curr - prev AS delta
FROM eval_results
WHERE suite = 'terminal-bench-2.0' AND agent_version IN ('0.6.1', '0.6.2')
GROUP BY task_id
HAVING delta < 0                 -- regressions only (delta > 0 = newly fixed)
ORDER BY task_id;
```

### 4. Regression vs best-ever (catch silent drift)
Tasks the agent used to pass but the latest version fails.
```sql
WITH latest AS (
  SELECT task_id, argMax(passed, started_at) AS curr_pass
  FROM eval_results WHERE suite = 'terminal-bench-2.0' GROUP BY task_id
)
SELECT r.task_id, max(r.passed) AS ever_passed, latest.curr_pass
FROM eval_results r INNER JOIN latest USING (task_id)
WHERE r.suite = 'terminal-bench-2.0'
GROUP BY r.task_id, latest.curr_pass
HAVING ever_passed = 1 AND latest.curr_pass = 0;
```

### 5. Ablation main effect (does a graph layer help?)
Average resolved rate with the memory graph ON vs OFF (runbook §5).
```sql
SELECT graph_mem, avg(resolved_rate) AS resolved_rate, count() AS runs
FROM eval_runs FINAL
WHERE harness = 'terminal-bench' AND suite = 'terminal-bench-2.0'
GROUP BY graph_mem;              -- compare the two rows
```

### 6. Wipe-reversion (causal self-improvement test, runbook §7.3)
Warm (peak) vs wiped vs cold for one experiment — the wipe should drop back to cold.
```sql
SELECT labels['phase'] AS phase, avg(resolved_rate) AS resolved_rate
FROM eval_runs FINAL
WHERE run_group = 'tb2-wipe-reversion'         -- phase ∈ {cold, warm, wiped}
GROUP BY phase ORDER BY phase;
```

### 7. Cost-normalized comparison
Resolved rate and cost-per-resolved-instance per agent (runbook §6.9).
```sql
SELECT agent_name, agent_version,
       avg(resolved_rate) AS resolved_rate,
       round(sum(metrics['cost_usd']) / nullIf(sum(n_passed), 0), 2) AS cost_per_resolved
FROM eval_runs FINAL
WHERE suite = 'terminal-bench-2.0'
GROUP BY agent_name, agent_version
ORDER BY resolved_rate DESC;
```

## Regression gate in CI

Run query #3/#4 after each eval run; fail the job if any `delta < 0` (or any `ever_passed=1 AND curr_pass=0`) on the agent-vs-its-last-release comparison. That is the behavioral analogue of the coverage ratchet: the agent may not get worse on a task it previously solved. Pair with the engram context-quality gate (`detectRegressions` in `packages/engram/src/eval/`) which gates the *context* axis the same way.
