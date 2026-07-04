---
title: "Bench Report & Dashboard"
description: "Archived spec & plan — status: not started (audited 2026-07-03)."
---

> **Status: Not started** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The spec exists (corrected 2026-07-04) but no implementation code has shipped. Core deliverables missing: bench-report.ts generator, pnpm bench:report script, report subcommand in @oxagen/bench CLI, history page in bench/web with timeline aggregation function, live ClickHouse route handler, and environment flag registrations.

**Implementation evidence**

- docs/specs/bench-report-and-dashboard.md — spec committed with full design (git: 2c325044), corrected 2026-07-04 (d326db08) to clarify private @oxagen/bench structure
- packages/bench/src/ — underlying ClickHouse query/ingest/CLI infrastructure exists (query.ts, ingest.ts, commands.ts with list/replay), but no report subcommand
- bench/web/src/app/page.tsx — basic dashboard component loaded, but no /history route or history.tsx page
- bench/web/src/lib/summary.ts — provenance + summarizeRuns utility exists, but no timelineByPair() aggregation function

**Known gaps at time of archive**

- tools/scripts/bench-report.ts — core generateBenchReport() function (non-LLM sections, SVG charts, all report sections)
- tools/scripts/bench-report.test.ts — unit tests for report generation, delta computation, no-LLM fallback
- pnpm bench:report script in root package.json — exposes report CLI
- packages/bench/src/commands.ts:handleBenchReport() — subcommand for pnpm --filter @oxagen/bench report
- bench/web/src/app/history/page.tsx — history/timeline UI component
- bench/web/src/lib/summary.ts:timelineByPair() — groups runs by (dataset, agent, model), orders by finished_at
- bench/web/src/app/api/history/route.ts — live-mode ClickHouse query handler (BENCH_WEB_LIVE conditional)
- bench/web/src/lib/summary.test.ts — timeline aggregation tests, E2E screenshot capture
- bench/swe-bench/run.sh auto-hook — pnpm bench:report call after results ingestion
- Environment flag registrations: OXAGEN_BENCH_REPORT_MODEL, OXAGEN_BENCH_REPORT_NO_LLM, BENCH_WEB_LIVE in packages/config/src/registry.ts + .env.example

**Source documents** (archived verbatim below)

- `docs/specs/bench-report-and-dashboard.md`

## Document — `bench-report-and-dashboard.md`

## Bench Report + Historic Dashboard Spec

**Status:** Draft · **Branch:** `feat/swe-rank1-scalpel` (or its own branch) · **Owner:** Mac Anderson
**Goal:** Every benchmark run produces a self-contained, intuitive-yet-detailed `bench-report-<timestamp>.html` with an LLM-written recap ("what this benchmark means / how we did") and LLM recommendations for the next run. Separately, the bench web app gains a **historic-runs dashboard** showing progress over time.

This spec builds on the "Scalpel" work (`docs/specs/swe-rank1-scalpel.md`): the report is how we *see* whether each Scalpel feature moved the needle, run over run.

> **Corrected 2026-07-04 (see PR that added this note):** the bench ClickHouse schema + ingestion + CLI shipped as a **private, never-published `packages/bench` package**, not inside `packages/telemetry`/`apps/cli` as first written below. The distributed `oxagen` CLI must never carry bench tooling — that was the whole point of the restructure. Paths and CLI invocations in this section (and in R1/R-B below) are updated to match; the *design intent* of R1/R2 is untouched, only *where the code lives* changed. If you're implementing against this spec, use the corrected paths, not the originals.

---

### 0. What already exists (build on it, don't rebuild)

Ground truth from the current tree — reuse these, do not reinvent:

- **Results on disk:** `bench/swe-bench/run.sh` writes `results-$AGENT/<job>/bench-config.json` (secret-free replay snapshot: `gitSha`, `OXAGEN_*` config incl. the new `OXAGEN_EFFORT`, `conditions`) plus per-task `<task>__<hash>/{result.json, agent/oxagen.txt, verifier/report.json, verifier/test-stdout.txt}`.
- **Normalization:** `bench/swe-bench/emit_eval_json.py` → `*.eval.json` (shared `oxagen_terminal_bench.eval_normalize.build_eval_json`), copied into `bench/swe-bench/results/`.
- **ClickHouse store** (`packages/bench/migrations/0001_bench_schema.sql`, applied via a private internal migrate entry — `pnpm --filter @oxagen/bench migrate` — never the product's `packages/telemetry/src/migrate.ts`/`db:migrate`), all `ReplacingMergeTree(updated_at)` (read with `FINAL`):
  - `bench.benchmark_run` — per job: `public_id` (`#N`), `bench_type`, `dataset`, `agent`, `git_sha`, `config` (JSON), `n_tasks`, `n_resolved`, `resolved_rate`, `total_cost_usd`, `tokens_in/out/cache`, `status`, `started_at`, `finished_at`.
  - `bench.benchmark_run_result` — per task: `public_id`, `task_id`, `reward`, `resolved`, `cost_usd`, `tokens_in/out/cache`, `duration_s`, `tool_calls_json`, `status`, `verifier_stdout`.
  - `bench.benchmark_candidate` — per best-of-N candidate: `is_winner`, `steps`, `files_changed`, `tokens_in/out`, `model`, `tool_calls_json`.
- **Query layer:** `packages/bench/src/query.ts` (exported from `@oxagen/bench`, a private never-published package) — `listBenchResults`, `getBenchResultByPublicId`, `getBenchRunByPublicId`, `getBenchCandidatesForResult`.
- **Ingest:** `packages/bench/src/ingest.ts` (`ingestBenchResultsDir`, `insertBenchmarkRun/RunResults/Candidates`), driven today by the one-off `tools/scripts/bench-backfill.ts`. **This is a different pipeline from `tools/scripts/eval-ingest.ts`/`pnpm eval:ingest`** — that one populates the older, coarser cross-harness `eval_runs`/`eval_results` trend tables from committed `.eval.json` files, not `bench.*`. Don't conflate the two when wiring `run.sh`'s auto-ingest hook.
- **CLI:** `packages/bench/src/commands.ts` + `packages/bench/src/cli.ts` — **internal-only, not part of the distributed `oxagen` CLI** (excluded from the product on purpose; `apps/cli` must never import `@oxagen/bench`). Invoke via `pnpm --filter @oxagen/bench list` / `pnpm --filter @oxagen/bench replay -- #N [--run]`.
- **Web app:** `bench/web/` (`@oxagen/bench-web`, `pnpm eval:app`, port 3200) — an internal dashboard app, not the distributed product, so it may depend on `@oxagen/bench` directly. Loads static `.eval.json` from `src/results-data/`, aggregates via `src/lib/summary.ts` (`summarizeRuns`), MEASURED/REFERENCE/SAMPLE provenance policy.
- **HTML design precedent:** `bench/web/benchmark-findings.html` — dark theme (`--bg:#0d0d0f`, `--text:#e8e8f0`, ember accent `--ember:#f97316`), embedded CSS, `.hero`/`.section-title`/`.tag-*` provenance badges, max-width 1080px. **Mirror this exactly** so report and dashboard read as one system.

**Data-model gap to fix on the way:** per-task `cost_usd` is hardcoded to 0 in `ingest.ts` (cost lives only at run level). The report must therefore source per-task cost as `run.total_cost_usd × (task tokens / run tokens)` as an *estimated* split, clearly labelled, until real per-task cost attribution lands. Filing that as a follow-up, not a blocker.

---

### 1. Feature R1 — `bench-report-<timestamp>.html` generator

#### Deliverable

A generator that, given one benchmark run (by `#public_id` from ClickHouse, or by a results dir path for offline), emits a single self-contained HTML file — no external CSS/JS/CDN, embedded data + inline SVG charts, dark-theme, matching `benchmark-findings.html`.

#### Location & invocation

`tools/scripts/bench-report.ts` (TypeScript via `tsx`, `.env.local`-aware, ClickHouse-queryable), exposed as:
- `pnpm bench:report <run-public-id> [--out <path>]` (new root `package.json` script), and
- `pnpm --filter @oxagen/bench report -- #N [--out <path>] [--open]` — a thin new subcommand added to `packages/bench/src/cli.ts`/`commands.ts` wrapping the same core function (`generateBenchReport`). **Not `apps/cli`** — bench tooling must never ship in the product CLI (see the private-package restructure).

Auto-hook: `run.sh` calls `pnpm bench:report` (best-effort, non-fatal) after a run finishes and its results are ingested, writing `results-$AGENT/<job>/bench-report-<job-name>.html` next to `bench-config.json`. The `<timestamp>` in the filename is the job name (already a UTC timestamp, `run.sh:157`).

#### Data sourcing

Core function `generateBenchReport(source): Promise<string>` where `source` is either `{ runPublicId: number }` (query ClickHouse via `query.ts`) or `{ resultsDir: string }` (read + normalize `.eval.json` offline — reuse `emit_eval_json.py` output shape, no re-run). Returns the HTML string; the caller writes it.

Pull: the `benchmark_run` row, all its `benchmark_run_result` rows, and (when present) `benchmark_candidate` rows. Never query Neo4j/Postgres — this is pure ClickHouse + files.

#### Report sections (in order)

1. **Hero** — run `#N`, dataset, agent, model(s), `git_sha` (short), effort (`config.OXAGEN_EFFORT`), started/finished, wall-clock. Provenance badge MEASURED. The headline number: **resolved-rate as a large figure** with `n_resolved/n_tasks`, and a one-line delta vs. the previous run of the same (dataset, agent) pair ("+3.2pp vs #\<M>").
2. **LLM recap** (see §1.1) — 2–4 paragraphs: what this benchmark measures, how we did in plain terms, what the number means competitively (contextualize against the known SOTA line — Lingxi V2.0 81.2%, live-SWE/Sonar 79.2% — as REFERENCE, dated), and the single most important takeaway.
3. **Scorecard grid** — stat tiles: resolved-rate, mean/median tokens per task (in/out/cache split), estimated cost per instance, mean/median wall-clock per task, error rate (`status=errored` share), and — when Scalpel flags were on — rung distribution and fast-path %. Each tile shows the value and, where a prior run exists, a small up/down delta.
4. **Per-task table** — sortable (client-side, vanilla JS inlined): task_id, resolved ✓/✗, reward, tokens, est. cost, duration, tool-call count, status. Rows link to an expandable detail (verifier stdout tail, tool-call breakdown from `tool_calls_json`). Resolved rows green, errored rows amber, unresolved neutral — matching the `.tag-*` palette.
5. **Best-of-N breakdown** (only if candidates exist) — per resolved-via-fork task: candidates, which won (`is_winner`), steps/files-changed/model each, and — once F4/F5 land — selection method (consensus vs selector). This is where cache-forked best-of-N's behavior becomes visible.
6. **Failure gallery** — the unresolved/errored tasks with a one-line LLM-classified failure reason each (wrong-spec / wrong-diagnosis / collateral-test-break / timeout / infra), so patterns jump out. Reasons come from the LLM pass in §1.1.
7. **LLM recommendations** (see §1.1) — a ranked list of concrete next-run changes (e.g. "raise diff budget on sympy tasks", "enable OXAGEN_SPEC_GATE — 4 of 7 failures never wrote a repro"), each tied to evidence in this run's data.
8. **Reproduce footer** — the exact `bench-config.json` env and the one-line command to replay (`pnpm --filter @oxagen/bench replay -- #N --run`), MEASURED provenance, git sha.

#### Charts

Inline SVG only (no chart lib, CSP-safe): a resolved/unresolved/errored donut, a per-task duration histogram, and a tokens-vs-resolved scatter. Keep them small and legible in both the light and dark rendering of the shared theme.

#### 1.1 The LLM passes (recap, failure classification, recommendations)

- All LLM calls go through **`@oxagen/ai`** (never import `ai` directly — metering/telemetry, per CLAUDE.md), model resolved via `modelIdOf()`. Default to a cheap tier (Haiku) for classification, a mid tier for the recap/recommendations; overridable via `OXAGEN_BENCH_REPORT_MODEL`.
- **Input to the model is data, not prose:** pass a compact JSON digest (aggregate stats, the per-task outcome list, the previous run's headline for delta, and the REFERENCE SOTA line) — never the raw trajectories (too big, and cost). Failure classification gets each failed task's problem statement + verifier stdout tail + diff stat, batched.
- **Output is structured** (`generateObject`): `{ recap: string, whatItMeans: string, takeaway: string, failures: Array<{taskId, reason, evidence}>, recommendations: Array<{change, rationale, evidenceRef}> }`. The generator renders that into the HTML sections — the model never emits HTML.
- **Determinism/offline:** if no AI key is available (or `OXAGEN_BENCH_REPORT_NO_LLM=1`), the generator still produces the full report minus the three LLM sections, with a neutral placeholder ("LLM recap unavailable — set AI_GATEWAY_API_KEY"). The report is never blocked on the model.
- **Honesty:** the recap must be grounded in the digest it was given (no invented numbers); the prompt instructs it to cite figures from the data and to say "regressed" when resolved-rate dropped. Every LLM-written block is visually tagged as LLM-generated so a reader never mistakes it for a measured figure.

#### Tests

`tools/scripts/bench-report.test.ts` (or co-located): given a fixture run digest, `generateBenchReport({resultsDir: fixtures/...})` returns HTML containing the resolved-rate, every task_id, and the reproduce command; produces a valid standalone doc (no `http://`/`https://` asset refs, no `<script src>`); the no-LLM path renders without calling the model (assert via a stubbed `@oxagen/ai`); the LLM path renders the structured object's fields (stubbed model returning a fixed object). Delta computation vs a previous run is unit-tested. **Do not run whole-repo suites** — narrow to this file / the telemetry package.

#### Acceptance

Running a small SWE-bench subset produces `bench-report-<job>.html` that opens offline in a browser, shows the correct resolved-rate and per-task rows, and (with a key) an LLM recap that names the actual number and a recommendation tied to a real failure. Byte-check: zero external asset references.

---

### 2. Feature R2 — historic-runs dashboard

#### Deliverable

A view in the bench web app (`bench/web/`) showing **progress over time**: resolved-rate and cost/latency trend lines across runs, filterable by (dataset, agent, model), with each point drilling into that run.

#### Design

- New route `bench/web/src/app/history/page.tsx` (the app already has `page.tsx`/`layout.tsx`). Link it from the existing landing page.
- **Data source, two modes** matching the app's current dual nature:
  - *Static mode (default, committed):* the existing `.eval.json` loader (`src/results-data/index.ts`) already feeds `summarizeRuns` (`src/lib/summary.ts`) — extend `summary.ts` with a `timelineByPair(runs)` that groups by (dataset, agent, model) and orders by `finished_at`, producing the series the chart needs. This keeps the app buildable with committed sample data and honors the MEASURED/SAMPLE/REFERENCE provenance policy.
  - *Live mode (opt-in):* a route handler (`src/app/api/history/route.ts`) that calls `listBenchResults`/`getBenchRunByPublicId` from **`@oxagen/bench`** (not `@oxagen/telemetry` — the bench query layer lives in the private bench package now; add `@oxagen/bench` as a `bench/web` workspace dependency) when `BENCH_WEB_LIVE=1` and ClickHouse env is present, returning the same series shape. The page prefers live when available, falls back to static.
- **Charts:** use the repo's charting convention. The web app is React — use **reaviz** (per the `reaviz` skill: LineChart/AreaChart for the resolved-rate-over-time and cost-over-time series, a scatter for tokens-vs-resolved across runs). Theme to the shared dark palette. Consult the `reaviz` and `dataviz` skills before writing chart code.
- **Provenance-honest:** REFERENCE lines (Lingxi 81.2%, etc.) render as dated horizontal rules on the resolved-rate chart so "how close are we to SOTA" is answerable at a glance, clearly badged as external references, never mixed into our own measured series.
- **Drill-in:** clicking a point routes to a run detail (reuse or link to the R1 HTML report for that run, or a React mirror of it — simplest is to serve the generated report).

#### Tests

Extend `bench/web/src/lib/summary.test.ts`: `timelineByPair` groups and orders correctly, handles a single run, and never merges different (dataset, agent, model) triples. If a live route handler is added, unit-test its series-shaping with a stubbed query layer. E2E (`bench/web` Playwright if present, else a render test) that the history page mounts and renders a chart with sample data. Screenshot the success state per repo verification discipline.

#### Acceptance

`pnpm eval:app` → `/history` shows a resolved-rate trend line over the committed sample runs with the SOTA reference rule, filterable by pair, each point linking to that run's detail. With `BENCH_WEB_LIVE=1` + ClickHouse, the same view reflects real ingested runs.

---

### 3. Build plan (evidence-per-effort)

| Phase | Work | Gate |
|---|---|---|
| **R-A** | `generateBenchReport` core (data sourcing from ClickHouse + offline dir, all non-LLM sections, inline SVG charts) + `pnpm bench:report` + tests. No LLM yet. | Report opens offline, correct numbers, zero external refs |
| **R-B** | LLM passes via `@oxagen/ai` (recap, failure classification, recommendations, structured output, no-LLM fallback) + `pnpm --filter @oxagen/bench report` subcommand + `run.sh` auto-hook | Report with a key shows grounded recap + a recommendation tied to a real failure |
| **R-C** | `timelineByPair` in `summary.ts` + `/history` static-mode page + reaviz charts + tests | `/history` trend line over sample data with SOTA rule |
| **R-D** | Live-mode route handler (ClickHouse-backed) + drill-in to run detail | `/history` reflects ingested runs under `BENCH_WEB_LIVE=1` |
| **R-E** (follow-up) | Real per-task cost attribution in `ingest.ts` (replace the hardcoded 0), so cost tiles stop being estimates | Per-task `cost_usd` non-zero end-to-end |

Rules (binding, from CLAUDE.md): work in the worktree, commit+push per phase, **never run whole-repo suites** (narrow to the touched package/file), all LLM calls through `@oxagen/ai`, every new env flag registered in `packages/config/src/registry.ts` + `.env.example` regenerated, dogfood via the oxagen CLI one-shot where the chunk is self-contained, and capture verification artifacts (a rendered report file, a `/history` screenshot) into `verifications/<session>/`.

New env flags to register: `OXAGEN_BENCH_REPORT_MODEL`, `OXAGEN_BENCH_REPORT_NO_LLM`, `BENCH_WEB_LIVE`.

---

### 4. Non-goals

- No new datastore — reuse the `bench.*` ClickHouse tables and the `.eval.json` static path.
- No PDF/email export — HTML only (the user can print-to-PDF).
- No live-streaming during a run — the report is generated post-run from settled results.
- No change to how runs are executed or ingested beyond the R-E cost-attribution fix.

