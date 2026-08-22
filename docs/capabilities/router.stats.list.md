# router.stats.list

**Capability name:** `list_routing_stats`
**Domain:** router
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

The **Pareto-curve read**: per (task class, model), the observed verified-success
rate and average cost/latency over a window, plus a derived per-class summary of
the cheapest model that currently clears the verified-success bar. This is how a
human sees what the router has learned from the org's own history. Read-only.

## Input

| Field        | Type                | Notes                                                    |
| ------------ | ------------------- | -------------------------------------------------------- |
| `taskClass`  | `string` (optional) | Restrict to one task class; omit for every class         |
| `windowDays` | `integer` (optional)| Trailing window; omit ⇒ the effective policy's window    |
| `minSamples` | `integer` (optional)| Min samples per (class, model); omit ⇒ policy's minSamples|

## Output

| Field                          | Type                | Notes                                                        |
| ------------------------------ | ------------------- | ------------------------------------------------------------ |
| `rows`                         | `array`             | One per (task class, model): `taskClass, model, tier, samples, verifiedCount, verifiedRate, avgCostUsdMicros, avgLatencyMs, lastSeen` |
| `summary`                      | `array`             | Per class: `taskClass, cheapestEligibleModel (nullable), verifiedRate, avgCostUsdMicros, candidateCount, eligibleCount` |
| `window`                       | `object`            | `{ windowDays, minSamples, successThreshold }` the read used |

## Side effects

None. Reads the append-only `router_outcomes` ClickHouse table (tenant-scoped).
