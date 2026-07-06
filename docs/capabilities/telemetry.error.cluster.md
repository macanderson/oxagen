# telemetry.error.cluster

**Domain:** telemetry
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low
**Aliases:** `telemetry_error_cluster` (agent-surface tool name)

## Intent

See **which error classes are recurring and how often** across the whole org,
as a small, typed list — the fleet-wide triage overview. This is the
structured-tool half of [ADR-021](../adr/ADR-021-inference-doctrine.md) §1/§3:
a bounded `GROUP BY fingerprint` over ClickHouse `error_events`, pure SQL,
**zero model calls**. Raw error rows never reach the caller — only the
clustered, capped summary.

Prefer `telemetry.error.cluster` over reading raw errors when you want the
**shape** of what's failing platform-wide. Anti-trigger: to diagnose **one**
specific failed execution (failing step, stack, suspect files), use
[`agent.debug.trace`](agent.debug.trace.md) instead — this is the fleet-wide
histogram, not a single-run frame.

## How it works (deterministic, pure SQL)

1. **ClickHouse `error_events`**, filtered to the org and a lookback window
   (`sinceHours`), optionally narrowed to one `severity` and/or `source`.
2. Rows are grouped **strictly by `fingerprint`** — the stable grouping key
   (SHA-256 of `error_class` + normalized message) computed at capture time.
   Every other selected column is aggregated (`argMax` for the most recent
   sample, `count()`, `min`/`max` for the window bounds) — never a bare
   aggregate alias inside `GROUP BY` (that is ClickHouse error 184).
3. Clusters are ranked by occurrence `count`, highest first, and capped to
   `limit`.
4. A second, non-grouped aggregate over the same filters computes
   `totalErrors` and `distinctClusters` for the **whole** window, so callers
   can tell whether the returned page was truncated.

## Input

| Field        | Type       | Default | Notes                                                                 |
| ------------ | ---------- | ------- | ---------------------------------------------------------------------- |
| `sinceHours` | `number?`  | `24`    | Lookback window in hours (1–720 / 30 days).                            |
| `severity`   | `enum?`    | all     | `"fatal" \| "error" \| "warn"`.                                        |
| `source`     | `string?`  | all     | Capturing runtime, e.g. `api \| app \| mcp \| inngest \| runner`.       |
| `limit`      | `number?`  | `20`    | Max distinct clusters returned, ranked by occurrence count (1–100).     |

## Output

| Field              | Type              | Notes                                                                 |
| ------------------ | ----------------- | ---------------------------------------------------------------------- |
| `clusters`         | `ErrorCluster[]`  | Ranked by `count` descending, capped to `limit`.                       |
| `totalErrors`       | `number`         | Total error occurrences in the window, across every fingerprint.      |
| `distinctClusters`  | `number`         | Total distinct fingerprints in the window (may exceed `clusters.length`). |
| `truncated`         | `boolean`        | True when `distinctClusters` exceeds the returned page.                |
| `window`            | `{ sinceHours }` | Effective lookback window actually applied.                            |

`ErrorCluster` = `{ fingerprint, errorClass, sampleMessage, severity, source, count, firstSeen, lastSeen }`.
`sampleMessage` is the most recent occurrence's message, bounded (≤ 600 chars).

## Surfaces

`agent` (as `telemetry_error_cluster`),
`api` (`GET /v1/{org}/telemetry/error/cluster?sinceHours=&severity=&source=&limit=`),
`mcp` (`telemetry.error.cluster`).
