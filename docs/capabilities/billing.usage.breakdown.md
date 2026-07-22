# billing.usage.breakdown

**Domain:** billing
**Mode:** sync
**Scope:** tenant

## Intent

Return aggregated usage (tokens, cost, and metered call counts) for a bounded
time window, broken down by model, surface, and workspace, plus a daily time
series. Powers the usage dashboard — the metering→billing visibility surface.

Read-only and `noBillingGate`: reading your own spend must never consume credits
or be gated on credit balance (otherwise an org out of credits could no longer
see that it had run out). The call still flows through `invoke()`, so it is
observed (OTEL span, surface tag, duration) like every capability.

## Input

| Field         | Type                       | Notes                                                        |
| ------------- | -------------------------- | ------------------------------------------------------------ |
| `start`       | `string` (ISO 8601)        | Start of the window, inclusive.                              |
| `end`         | `string` (ISO 8601)        | End of the window, exclusive. Must be after `start`.         |
| `workspaceId` | `string` (UUID), optional  | Narrow to a single workspace. Omit for org-wide.             |

Cross-field rules: `end > start`, and the window may not exceed 366 days. The
org boundary is always the caller's tenant context — `workspaceId` only narrows
within it, never across orgs.

## Output

Every measure below is `inputTokens` / `outputTokens` / `cachedTokens` (prompt-cache
READS) / `cacheWriteTokens` (prompt-cache WRITES, billed at the provider premium —
#1076) — all non-negative integers, `costMicros` (micro-USD; 1 USD = 1,000,000),
`executions` (metered `token_usage` rows), and `messages` (distinct chat turns).
`cachedTokens` and `cacheWriteTokens` are both SUBSETS of `inputTokens`, not
additive (the `@oxagen/ai` gateway reports `inputTokens` as the inclusive total).

| Field               | Type                       | Notes                                                        |
| ------------------- | -------------------------- | ------------------------------------------------------------ |
| `range`             | `{ start, end }`           | Echoes the requested window.                                 |
| `totals`            | measures                   | Sum across the window (derived from `byModel`).              |
| `cacheSavingsMicros`| integer (micro-USD)        | Estimated cache savings NET of the write premium: reads served cheaply minus writes' premium over fresh input, summed across models via the provider rate card. Positive = caching netted money; can go negative. Powers the dashboard "cache savings" figure. |
| `series`            | array of `{ day, …measures }` | One point per UTC calendar day, chronological.            |
| `byModel`           | array of `{ key, provider, …measures }` | Grouped by model; `provider` is the provider slug. |
| `bySurface`         | array of `{ key, provider: "", …measures }` | Grouped by surface (`api`/`mcp`/`app`/`agent`/…). |
| `byWorkspace`       | array of `{ key, provider: "", …measures }` | Grouped by `workspace_id`.                     |
| `byCapability`      | array of `{ key, provider: "", …measures }` | Grouped by capability name (principal spine). |
| `byPrincipal`       | array of `{ principalId, principalKind, …measures }` | Grouped by acting principal.         |
| `byUser`            | array of `{ userId, …measures }` | Grouped by acting user (seat-level view).                |

Breakdown rows are ordered by cost descending, then executions descending.

## Side effects

- Postgres: none.
- ClickHouse: read-only aggregate (`GROUP BY`) over `token_usage`, filtered by
  `org_id` (always) and `workspace_id` (when supplied).
- Neo4j: none.

## Errors

| code             | meaning                                       |
| ---------------- | --------------------------------------------- |
| `tenant_missing` | No active tenant on the request context.      |
| `forbidden`      | Caller lacks a billing-manager role on org.   |
| `invalid_input`  | Window fails validation (order / 366-day cap).|

A ClickHouse outage propagates as an error rather than returning silent zeros —
callers that need resilience (the dashboard page) wrap the invoke and degrade
explicitly.

## Surfaces

- **API:** `GET /v1/:org/:workspace/billing/usage/breakdown?start&end&workspace_id`
- **MCP:** tool `billing.usage.breakdown`
- **App:** `/{org}/billing/usage` dashboard
