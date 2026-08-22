# 02 — Data model, metrics & contracts

This is the honest backbone. Every stat traces to a real column in a real store, or it is
flagged as *not yet emitted*. Nothing is promised that the data can't back.

## 1. The four sinks (know the grain)

Usage crosses all four stores. Four cross-cutting sinks matter here:

| Sink | Store | Grain (one row per…) | Key field | Written by |
|---|---|---|---|---|
| **`token_usage`** | ClickHouse | **LLM / embedding / image / video gateway call** | `capability_name` | `insertTokenUsage` — `packages/telemetry/src/clickhouse.ts:382` |
| **`tool_invocations`** | ClickHouse | **agent tool call** (+ graph deletes) | `capability_name` | `insertToolInvocation` — `clickhouse.ts` (agent loop) |
| **`audit_events`** | ClickHouse (7yr TTL) | **kernel invocation on IAM-bootstrapped surfaces** | `capability` | `emitAudit` — `packages/iam/src/emit-audit.ts` |
| **`security_events`** | Postgres | **kernel invocation, ALL surfaces** | `capability` | `recordSecurityEvent` — `packages/telemetry/src/security.ts` |

Canonical capability names are **verb-first snake_case** (ADR-025) stored in
`capability_name`/`capability` — `generate_image`, `open_pr`, `write_memory`. Never the dotted
filename.

`token_usage` is the **metering spine** (365-day TTL, billing-grade). Authoritative schema:
`packages/telemetry/src/schema.sql:43` + migrations `0002/0005/0023`; TS row type
`TokenUsageRow` at `clickhouse.ts:212`. The aggregation layer is
`packages/telemetry/src/usage-analytics.ts::readUsageBreakdown` — **this is the file to extend**.

## 2. Contract design

### 2.1 Extend `get_usage_breakdown` (the org + workspace spine)

`billing.usage.breakdown` already returns, over ClickHouse `token_usage` for `ctx.orgId`
(+ optional `workspaceId`) within `[start, end)`:

```
totals:    { inputTokens, outputTokens, cachedTokens, costMicros, executions }
series[]:  { day, ...totals }                       // daily
byModel[]  byProvider(any) bySurface[] byWorkspace[] byCapability[] byPrincipal[]
```

Add, migration-free (columns already exist and are populated by the ambient principal stamp):

- **`byUser[]`** — `GROUP BY user_id` (backs the per-user slice on all three surfaces).
  `user_id` is stamped at insert from `getPrincipalAttribution()` but never grouped today.
- **`messages`** on `totals`/`series`/each breakdown — `count(DISTINCT execution_step_id)`
  (see §5 for the grain decision).
- **Optional server-side filters** on the input schema so a slice is a *narrower query*, not a
  client-side filter over a huge payload: `model?`, `provider?`, `surface?`, `capability?`,
  `userId?`, `principalKind?`. Each maps to a `WHERE` clause on `token_usage`. (Filters for
  `agentId` / `repoId` / `environmentId` are added in **Phase 3** once those columns exist —
  see tier 3.)

Keep the existing invariant: **tenant boundary is `ctx.orgId`, never input.** `workspaceId`
input only *narrows within* the caller's org.

### 2.2 New `get_my_usage` — the cross-org, self-scoped contract  ⚠ auth-sensitive

The user Usage tab (`/account/usage`) is **global**: it must aggregate a user's activity
**across every org they belong to**. `get_usage_breakdown` cannot do this — it is locked to a
single `ctx.orgId`. So we add a *deliberately* cross-tenant contract with a hard, narrow guard.

**Security invariant (must be implemented exactly, and stated in the contract doc):**

> `get_my_usage` returns **only** rows where `user_id = the authenticated session user's id`.
> That id is derived **server-side from the session** (`ctx.userId` / principal identity) and
> is **never** read from input. ClickHouse has **no Postgres-style RLS** — this `WHERE
> user_id = <session identity>` clause is the *sole* isolation guard, so it is not optional and
> not overridable. The `byOrg[]` breakdown lists only orgs where the session user has
> attributable activity; it must not leak the existence of orgs the user cannot see.

- **Input:** `{ start, end, workspaceId?, orgId?, model?, provider?, surface?, capability? }` —
  every filter *narrows within the self-scope*; none can widen it. `orgId?` here filters *the
  user's own rows* to one org (a drill-in), it does **not** change the tenant boundary.
- **Output:** same shape as `get_usage_breakdown` **plus `byOrg[]`** (`GROUP BY org_id`), so the
  tab can show "your usage across Acme / Beta / …".
- **Surfaces:** `api`, `mcp`, `agent`, and `app` in `layers[]` (it needs a real app page). Because
  it doesn't take a tenant from input, `check:manifest` may flag it — document the reason inline.
- **Handler:** a sibling to `readUsageBreakdown` — `readMyUsage({ userId, start, end, ...filters })`
  in `usage-analytics.ts`, identical projection with `WHERE user_id = :userId` and no `org_id`
  predicate (plus optional `org_id = :orgId` when the drill-in is set).

### 2.3 New tile contracts for the tier-2 (non-token) activity metrics

These live in *other* stores. Rather than a mega-contract that reads three stores (which would
break the four-store boundary — see §4), each is its own small contract feeding an independent,
fail-open tile:

| New contract (proposed name) | Store | Returns | Backs |
|---|---|---|---|
| **`get_generated_asset_stats`** | Postgres `generated_assets` | `total` + `byKind[]` (image/video/document/pdf/spreadsheet/presentation/archive) + daily `series`, `WHERE source='generated'`, filterable by org/workspace/user/model/time | docs · images · videos generated |
| **`get_automation_stats`** | Postgres `workflow.playbooks` | `created` count + `byStatus[]` (draft/active/archived) + daily series, per org/workspace/user/time | automations created |
| **`get_repo_activity_stats`** | ClickHouse `tool_invocations` (+`audit`/`security`) | counts of `open_pr` / `put_repo_file` (+ `create_branch`, `fork_repo`) per org/workspace/user/time | PRs opened · commits |

**Reuse (already `app`-layer, no new contract):**

- **`get_graph_stats`** (`graph.stats`) → `nodeCount`, `edgeCount`, `inferredEdgeCount`,
  `nodesByLabel`, `edgesByType`, and a **14-day node-creation series**. Backs "nodes created"
  and the graph hero. (Deletes: ClickHouse `tool_invocations` `delete_node`/`delete_edge`.)
- **`list_executions`** (`agent.execution.list`) → run-level list for the Activity drill-in
  (per-run tokens/cost/latency/status/origin). The org-level *count* of runs comes from
  `agent_executions` (Postgres) — a small `get_execution_stats` aggregate may be added, or the
  execution count from `token_usage` (LLM-call grain) is used and **labeled as such**.
- **Memories created** — Neo4j `:AgentMemory.createdAt` (per-user via `created_by_id`). There is
  **no ClickHouse event** for memory creation, so this is either a Neo4j-reading tile
  (`get_memory_stats`, Neo4j) or deferred to Phase 3 where a `write_memory` emit is added. See
  tier-3.

Every new contract follows the wiring order (law): **contract → API route → MCP tool →
app UI**, with a `capability-ui-map.json` binding + runtime proof (UI Capability Parity).

## 3. Capability-pack counts — *derive the list, never hard-code it*

The user was explicit: *"do not take the names … as verbatim; derive them from across all the
org workspaces — see the distinct list of capabilities used and drive counts from those."*

- **The list:** `SELECT DISTINCT capability_name FROM token_usage WHERE org_id = :org AND
  created_at ∈ window` (and/or `tool_invocations` for the all-agent-tool grain). This is exactly
  the `byCapability[]` breakdown `readUsageBreakdown` already returns — it is dynamic by
  construction.
- **The counts:** `GROUP BY capability_name`. For the *capability-pack* framing (image / video /
  pdf / svg generation), the relevant capability names surface naturally
  (`generate_image`, `create_image`, `generate_video`, `create_pdf`, `generate_document`,
  `generate_svg`, `mermaid.generate`…). The UI groups them into families **by a small display
  map** (family label + icon), but the *data* is always the distinct set — a new capability pack
  appears automatically the first time it's used.
- **Grain caveat (state it in the tile):** `token_usage` is per-**gateway-call** (≈1:1 for
  image/video, but chat over-counts because one turn is many calls). For a clean per-**artifact**
  count (N images, N videos, N documents) use `generated_assets GROUP BY kind` (§2.3); use
  `capability_name` counts for "how often was each capability *invoked*." The two answer
  different questions — the org page shows both, labeled.
- SVG persists as `kind='image'`, mime `image/svg+xml`; mermaid/markdown as `kind='document'`
  with distinguishing mime — split those out by `mimeType` where the family matters.

## 4. Composition rule — one tile per store, never a cross-store query

The org dashboard needs numbers from ClickHouse (tokens/caps), Postgres (`generated_assets`,
`playbooks`, `agent_executions`), and Neo4j (`AgentMemory`, graph). **Do not** build a single
contract/handler that reaches into three stores — that violates the infrastructure boundaries
(CLAUDE.md) and couples failure domains. Instead:

- Each metric family is its own contract over its own store.
- The **page** composes them, each tile **independently Suspense-streamed and fail-open**
  (degrade to a skeleton/zero with a hint, never fail the whole page) — the exact pattern the
  workspace overview already uses (`apps/app/.../[workspaceSlug]/page.tsx`).
- A ClickHouse outage greys the token tiles but leaves the Postgres-backed tiles live, and
  vice-versa. This is a resilience feature, not just tidiness.

## 5. The tricky definitions (get these right or the numbers mislead)

### Cache "read vs miss (hit rate)" — partially backed; define honestly
- **Cache reads** = `token_usage.cached_tokens` (real; sourced from AI SDK
  `inputTokenDetails.cacheReadTokens`). It is a **subset of `input_tokens`**, not additive.
- **Cache misses** — `token_usage.cache_misses` column exists but has **zero writers (always 0)**.
- **Cache writes/creation** — **no tenant column** (only the non-tenant `agent_executions`
  Claude-Code table has `cache_tokens_created`).
- **Therefore the only honest hit-rate today is `cached_tokens / input_tokens`** — the
  *cache-read share of input tokens*. The UI labels it exactly that ("Cache-read share"), with a
  tooltip. A true read/write/miss ratio is a **Phase-3** emit (populate `cache_misses` + add a
  `cache_creation_tokens` column at the insert path). Do **not** ship a "hit rate" that divides
  by a column that's always zero.

### Messages / chat turns — pick one grain, note it
- Cheapest: `count(DISTINCT execution_step_id)` on `token_usage` — but it includes a
  `NIL_UUID` bucket (calls with "no step") and only counts LLM-touching turns.
- Truer: Postgres `messages` table (durable conversation record). **Decision:** the org/user
  *strip* uses `count(DISTINCT execution_step_id)` (co-located with the token query, one round
  trip) and labels it "Chat turns (LLM)". If product wants exact conversation counts later, add a
  `get_message_stats` Postgres tile. Note the grain in the tooltip.

### Executions — two grains coexist
- `token_usage.executions` = `count()` of metered **LLM calls** (what `readUsageBreakdown`
  returns). Label: "LLM calls."
- Postgres `agent_executions` = agent **runs** (`originType`, `status`, `latencyMs`). Label:
  "Agent runs." The org page shows **runs** in the headline strip (what users mean by
  "executions") and LLM-calls in the token breakdown.

## 6. Timeframes — presets, previous-period, and the 366-day cap

The user's presets, each with a **defined previous period** so `DeltaChip` has a comparison
(a delta is a *second query* over the prior window, not free):

| Preset | Current window | Previous window (for delta) |
|---|---|---|
| Today | 00:00 today → now | same clock span yesterday |
| Yesterday | full prior day | day before |
| This week | week start → now | prior full week |
| Last week | prior full week | week before |
| This month | month start → now | prior full month |
| Last month | prior full month | month before |
| This quarter | quarter start → now | prior full quarter |
| Last quarter | prior full quarter | quarter before |
| This year | year start → now | prior full year |
| Last year | prior full year | year before |
| Custom | user range | equal-length window immediately before it |

**Hard constraint:** `get_usage_breakdown` rejects ranges **> 366 days** (contract refinement).
So "custom" caps at 366 days, and **year-over-year is two separate queries**, not one span. The
range picker must enforce the cap client-side with a clear message, and the
current+previous pair is always two `WHERE created_at ∈ …` queries. Timezone: anchor presets to
the **org's configured timezone** (fall back to UTC) so "today" means the customer's today.

## 7. The full metric → source map (the honesty table)

| Requested metric | Source | Tier | Notes |
|---|---|---|---|
| Executions (runs) | Postgres `agent_executions` | 1/2 | headline "Agent runs"; LLM-call count from `token_usage` too |
| Messages / chat turns | `token_usage` `distinct execution_step_id` (or PG `messages`) | 1 | grain noted (§5) |
| Total / in / out tokens | `token_usage.input_tokens`,`output_tokens` | 1 | backed |
| Cache read (hit-rate) | `token_usage.cached_tokens / input_tokens` | 1 | "cache-read share" only |
| Cache miss / write | — | 3 | `cache_misses`=0; no write column |
| Cost / USD | `token_usage.cost_usd_micros` | 1 | micro-USD |
| Model / provider / surface / capability | `token_usage.model/provider/surface/capability_name` | 1 | — |
| Principal (who) | `token_usage.principal_id/principal_kind` | 1 | human/agent/service |
| **User** | `token_usage.user_id` | 1 | needs `byUser` GROUP BY (new, migration-free) |
| **Org (cross-org for a user)** | `token_usage.org_id` + `get_my_usage` | 1 | new self-scoped contract (§2.2) |
| **Agent / agent-version** | — | 3 | no column; enrichment phase |
| **Repo** | — (activity: `open_pr`/`put_repo_file` counts) | 2/3 | slice-by-repo needs a column; PR/commit *counts* are tier-2 |
| **Environment** | — | 3 | no column; enrichment phase |
| Docs / images / videos / pdf / svg generated | Postgres `generated_assets GROUP BY kind` (+mime) | 2 | per-artifact; `get_generated_asset_stats` |
| Capability-pack invocations (dynamic) | `token_usage.capability_name` distinct+count | 1 | §3 |
| Memories created | Neo4j `:AgentMemory.createdAt` | 2/3 | no ClickHouse event; Neo4j tile or new emit |
| Nodes created | Neo4j `createdAt` / `graph.stats` series; ingestion `graph_observed_labels` | 2 | reuse `get_graph_stats` |
| Nodes/edges deleted | ClickHouse `tool_invocations` `delete_node`/`delete_edge` | 2 | backed |
| Nodes/edges **updated** | only Neo4j last-write `updatedAt` | **3** | **the single hardest gap — needs a genuinely new upsert-handler emit** |
| Edges created | ingestion `graph_observed_labels` (`target_kind='relationship'`) | 2 | ingestion-driven creates |
| PRs opened / commits | `open_pr` / `put_repo_file` invocation counts | 2 | Oxagen-initiated, not GitHub truth |
| **Merges** | — | 3 | GitHub-side; webhook is ingestion-only today |
| Automations created | Postgres `workflow.playbooks` | 2 | `get_automation_stats` |
