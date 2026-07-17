# 01 — Proposal

## The pain, in one line

Oxagen meters everything — every LLM call, tool call, and capability invocation emits a
priced usage event — but a human can only *see* that usage in one place: the
`/{org}/billing/usage` dashboard, framed as a billing artifact. There is **no org home**, the
**workspace overview** shows a thin slice, and a **user cannot see their own footprint** at
all. The platform's headline promise is *"meter, govern, and bill your agents"*; today the
app makes the metering nearly invisible.

## Why this is on-vision (and passes the Vision Gate)

From [`docs/VISION.md`](../../VISION.md): the third pillar is *"Monetization — a
ClickHouse→Stripe loop that turns observed agent usage into billing,"* and a stated strategic
edge is *"the market is actively cutting AI spend — metering and cost attribution are budget
items."* Usage dashboards are the **cost-attribution surface** of that loop:

- **Advances metering→billing:** turns the already-collected `token_usage` stream into a
  first-class, sliceable product surface. (drift test #1: *does this help a team meter, govern,
  ground, or resell?* → **yes, meter + attribute**.)
- **Advances vendor-neutral fleet lineage:** slicing by model **provider** (anthropic / openai
  / google / bfl / xai …) makes BYOK cost visible per vendor — reinforcing the vendor-neutral
  design constraint rather than hiding spend behind one provider.
- **Advances resale:** the same aggregation that powers these dashboards
  (`readResellerUsageAttribution`) already drives reseller rebill. A clean per-user /
  per-workspace / per-capability view is the customer-facing twin of the rebill math.

This is **not** a new data pipeline; it is a UI + aggregation-contract layer on top of the
existing `invoke()` metering chokepoint. Routine surfacing of already-metered data reads as
*advances* to the Vision Gate, not *drifts*.

## What we deliver — three surfaces, one aggregation spine

All three read the same metering spine (`token_usage` via `readUsageBreakdown`) plus, for the
non-token activity metrics, the relevant Postgres/Neo4j domain tables — each surfaced as an
independent, fail-open tile (never a cross-store mega-query; see
[`02`](./02-data-model-and-metrics.md) §4).

### 1. Org dashboard — **new** — `/{org-slug}/dashboard`

`/{org-slug}` currently redirects to the first workspace. We repoint it to a real **org home**
(the thing workspaces have as an overview but orgs never had). Default scope: **whole org, this
month**, defaulting the workspace filter to *all workspaces*. This is the primary deliverable
and the surface the user described in most detail:

- **Core stat strip:** Executions · Chat turns (messages) · Total tokens · Tokens in · Tokens
  out · Cache-read share (hit-rate) · Cost · Pull requests · Commits.
- **Capability-pack strip (dynamic):** counts of *distinct capabilities actually used* —
  Documents/files, Images, Videos generated — derived from `SELECT DISTINCT capability_name`,
  never a hard-coded list (see [`02`](./02-data-model-and-metrics.md) §3).
- **Slices:** timeframe (preset + custom), model provider, model, surface, agent version,
  user, workspace, repo (see the applicability matrix in [`03`](./03-information-architecture.md)).
- **Breakdown tables + charts:** daily series (stacked bar), top models (bar list), by
  surface, by workspace, by user, by capability.

### 2. User usage — **new** — a profile summary box + a deep Usage tab

Two placements (the user named both): a **compact summary stat box on `/account/profile`** that
deep-links out, and a new **`/account/usage`** Usage tab for the drill-down (see
[`03`](./03-information-architecture.md) §3). The account section is global (cross-org). The
Usage tab gives a user their own footprint **across every org they belong to**, defaulting the
view to the current workspace but letting them drill by **org → workspace → model → timeframe →
repo → environment → agent**.
Because this crosses tenancy, it uses a **self-scoped** contract (`get_my_usage`) whose sole
guard is `user_id = the authenticated session identity` — see the security invariant in
[`02`](./02-data-model-and-metrics.md) §2.2. Same activity metrics as the org page: memories
created, executions, nodes/edges created·deleted·updated, files/images/videos generated,
PRs/merges/commits, automations created.

### 3. Workspace overview — **enhance existing** — `/{org-slug}/{workspace-slug}`

The overview HUD already has `MeteringKpiStrip`, `GraphHero`, `UsagePanel`, `MemoriesPanel`.
We (a) unify its KPI strip on the same `UsageStatCard` the other two surfaces use, (b) add the
missing core stats (chat turns, cache-read share, PRs/commits, generated artifacts), and (c)
add a compact "This workspace vs. org" delta so a workspace reads in context. The workspace
surface stays **workspace-scoped by default** — the requirement the user stated verbatim.

## Non-goals (explicit scope boundary)

- **Not PostHog.** No product-analytics events (funnels, retention, activation) belong here.
  This surface is metering only. (The bridge to PostHog is identity, not duplication.)
- **Not a new billing source of truth.** Stripe remains authoritative for money;
  `get_subscription` remains the only place a true credit *balance* lives. These dashboards
  show *observed usage and its cost*, which is reconciled to — not a replacement for — billing.
- **Not real-time streaming.** ClickHouse aggregation with a short cache is the model; sub-second
  liveness is out of scope.
- **Not a replacement for `/{org}/billing/usage`.** That page stays as the billing-framed view
  (credits, invoices adjacency). The org dashboard is the *operational* twin; they share
  components and the same contract, framed differently.
- **Not GitHub's source of truth for repo activity.** PR/commit counts reflect
  **Oxagen-initiated** actions (`open_pr` / `put_repo_file` invocations); true merges are a
  Phase-3 webhook concern (see [`02`](./02-data-model-and-metrics.md) tier 3).
