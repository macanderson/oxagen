---
# Evals — Unified Redesign

- **Route family:** `/{orgSlug}/{workspaceSlug}/evals` (+ `evals/datasets/[datasetId]`, `evals/runs/[runId]`)
- **Supersedes:** the drawer-based dataset detail + isolated run pages
- **Priority:** P1 (user-requested rework)
- **Disposition vs today:** Rework — merge runs into evals, drawer → full pages, free-text models → provider/model dropdowns, add run analytics

## Why (what the user asked for)
1. Eval **runs are not a separate concept from evals** — the evals home surfaces both datasets *and* recent eval runs with their results.
2. The two eval **drawers are removed**. A dataset gets a **full detail page** (items + run setup config + a filterable/sortable/paginated table of every run ever executed against it + performance charts). "New dataset" becomes a compact `Dialog`, not a slide-over.
3. Model/judge are **no longer free text**. A **provider dropdown (with the provider's brand logo)** controls a dependent **model dropdown**, sourced from the same `@oxagen/ai/catalog` the ask-page model picker uses. Reused for both the target model and the judge model.
4. The dataset detail page shows **all runs ever executed**, filterable by date (default = today), with an **all-time count**, **paginated**, in a **table sortable by score / date / model / status**.
5. **Charts / gauges**: a timeseries line chart of score over time, with the option to **compare models** on the same dataset, plus at-a-glance gauges (avg score, pass rate).

## Vision alignment (flagged per CLAUDE.md)
Standalone eval tooling is an explicit *fast-follow*, not the wedge (`docs/VISION.md` — "do not fight on the front line of … standalone evals (Braintrust)"). This rework is justified as (a) fixing the drawer UX and (b) **surfacing metered cost** — every run's tokens and cost (from the ClickHouse→Stripe metering pipe) are first-class in the runs table and available as a cost-over-time series, so "eval cost is visible cost." That keeps the work anchored to the metering→billing loop rather than pure quality benchmarking. Called out in the PR body for the Vision Gate.

## New capabilities (contract-first, contract → handler → api → mcp → docs)
Both are read-only, workspace-scoped, `surfaces: ["api","mcp","cli"]`, `layers` include `app`, `noBillingGate: true`, reader roles (Owner/Member/Viewer). Both read Postgres `eval.eval_runs` (transactional run summaries) joined to `eval.eval_datasets`; per-run cost/tokens come from one grouped ClickHouse read over the page's run ids (four-store model respected).

### `eval.run.list` — `list_eval_runs`
- **Input:** `{ datasetPublicId?, since? (ISO), until? (ISO), status?, model?, sortBy: "score"|"created"|"model"|"status" (default "created"), sortDir: "asc"|"desc" (default "desc"), limit (1..100, default 25), offset (>=0, default 0) }`
- **Output:** `{ runs: [{ runId, datasetId, datasetName, datasetSlug, name, target:{kind, model?, agentSlug?}, judgeModel, status, itemCount, completedCount, failedCount, avgScore, passThreshold, costUsdMicros, inputTokens, outputTokens, createdAt, completedAt }], total, allTimeTotal }`
- `total` = count matching filters; `allTimeTotal` = count for the workspace (or the dataset when `datasetPublicId` given) ignoring date/status/model filters — powers the "N run all time" line.

### `eval.run.series` — `eval_run_series`
- **Input:** `{ datasetPublicId?, since? (ISO), until? (ISO), bucket: "day"|"week" (default "day"), metric: "score"|"cost" (default "score") }`
- **Output:** `{ overall: [{ bucketStart, avgScore, runCount }], byModel: [{ model, vendor, avgScore, passRate, runCount, points: [{ bucketStart, avgScore }] }] }`
- Aggregates `avg_score` (and, for `metric:"cost"`, ClickHouse cost) by `date_trunc(bucket, created_at)` overall and grouped by `target->>'model'`. Powers the timeseries line + model-comparison lines.

## Frontend
- **`ProviderIcon`** (`apps/app/src/components/ai/provider-icon.tsx`) — inline brand SVGs for the 8 catalog vendors (anthropic, openai, google, xai, meta, mistral, deepseek, bfl). Dependency-free, brand-colored.
- **`ProviderModelPicker`** (`apps/app/src/components/ai/provider-model-picker.tsx`) — cascading provider `Select` (logo + name) → model `Select` filtered to that provider's text-capable `gatewayModels`. `value: { model: string | null }` (null = default tier). Reused for target + judge.
- **Evals home** (`evals/page.tsx`) — datasets grid (cards now link to the detail page) + a "Recent runs" table (workspace-wide, links to run detail) + a summary gauge/stat strip. No drawers; "New dataset" is a `Dialog`.
- **Dataset detail page** (`evals/datasets/[datasetId]/page.tsx`) — header + gauges; performance charts (score-over-time + model comparison); runs table (date filter default today, all-time count, server sort/paginate); inline run-setup/launcher (provider/model pickers, target kind, judge, threshold, max items) with status poll; dataset items list + inline add-item.
- Route helper `workspace.evals.dataset(ctx, datasetId)`; run-detail back-link points at the dataset detail page.
- `capability-ui-map.json` bindings + e2e proof for the newly-wired capabilities.

## Data sources
Postgres `eval.eval_runs` + `eval.eval_datasets` (list/series/summary); ClickHouse `eval_item_results` (per-run cost/tokens roll-up). Model catalog is the static client-safe `@oxagen/ai/catalog` — no new catalog API.
