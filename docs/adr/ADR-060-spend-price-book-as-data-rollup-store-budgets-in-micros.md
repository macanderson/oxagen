# ADR-060: Spend: the price book as data, the rollup store, budgets in micros

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** platform
- **Refines:** ADR-052 (the governed action is the billable unit; tokens are
  reported, never billed). This ADR is about the reported side: what a run
  cost the customer at their model providers, attributed to the operator,
  agent, model, tool and task, with a basis on every figure. Nothing here
  bills a token.
- **Related:** ADR-055 (GAU buckets; the billing page), ADR-057 §2 (the
  budget contracts carry `Money` in micros), ADR-042 (organisation data
  planes), the Mission Control spec `2026-09-11-oxagen-mission-control-spec.md`
  §12.2, §12.3, §12.5, §12.6, §12.7, §12.8, §12.9 and App. A.7,
  `apps/app/ARCHITECTURE.md` §3.4 (no fabricated zeros), INV-09 and INV-10,
  GitHub issue #2962 (the lane), #2820 (a stalled ClickHouse zeroed a spend
  ceiling while the customer kept being charged).

## Context

The mockup's Spend page prints a month total with a basis, spend by operator,
agent, model and tool, a drill page per key, wasted spend by cause, and
budgets; the Run page prints a cost strip and a Cost tab; the Fleet table a
cost column. The spec's rule is that every number that is money shows its
basis (§14), that money on the wire is micros (INV-09), and that a rollup is a
derived index rebuilt from frames (§12.3).

What existed before this decision: an in-code rate card
(`packages/billing/src/pricing.ts`: `PROVIDER_RATE_CARD`, `IMAGE_RATE_CARD`,
`VIDEO_RATE_CARD`) consumed by `providerCostUsdMicros`, which
`packages/billing/src/metering.ts` charges credits from with a `rateCardMiss`
flag when a model has no entry; a `get_usage_breakdown` that aggregates
ClickHouse `token_usage` live; a spend-budget gate that summed the same
ClickHouse table on every metered invoke and failed open when the store
stalled (#2820); `list_runs` reading a tacho session's own `total_cost_micros`
(`NOT NULL DEFAULT 0`) beside a nullable `cost_basis`; no price book as data,
no `cost.run_totals`, no `cost_basis` on any figure beyond the two the run
list knew.

## Decision

### 1. The price book is data, seeded from the in-code card

`cost.price_entries` holds every price Oxagen applies to a frame: provider,
model and aliases, region, token class, unit, integer micro-USD per one
million units, `[effective_from, effective_to)`, `source`, and a nullable
`org_id`. `pnpm billing:price-book-sync` (`tools/scripts/price-book-sync.ts`
→ `syncPriceBook` in `packages/billing/src/price-book.ts`) writes the list
rows (`org_id NULL`, `source 'list'`) from `pricing.ts`, which stays the seed
and the single source the sync reads; `packages/ai` holds no prices. A
re-run with the same `effective_from` corrects a price in place before it has
shipped; a run with a later `effective_from` adds new rows and closes the
previous ones at that instant, so a cost record priced before the change
keeps the entry it names. A sync that would start earlier than the open row
is refused: a correction is always a later row. Hand-entered rows carry
`source 'negotiated'` or `'override'` and an `org_id` (a CHECK ties the two);
they win over the list row for the same model and class.

`providerCostUsdMicros` keeps charging credits from the in-code card until
the rollup is the price book's only reader; then the card is the seed alone.
The rollup resolves a frame's model and class with `resolvePriceEntry`: the
organisation's rows first, then the list, by longest prefix over `model` and
`model_aliases`, on the id as given and then on the family behind a
`creator/` gateway prefix, at the frame's instant. No entry is a miss, and a
miss is recorded as `estimated`, never as a zero and never as a charge from a
guessed price.

### 2. The budget contracts carry `Money` in micros

Decided in ADR-057 §2 and shipped by that lane: `get_spend_budget` and
`set_spend_budget` carry `{ micros, currency }` for `limit`, `spent` and
`projected`; `billing.spend_budgets.limit_micros` has held the ceiling since
the table was created, so the change is on the wire only. This ADR records
that the spend family shares that shape: every money field on `get_spend`,
`get_spend_drill`, `get_run_cost`, `list_waste`, `export_statement`,
`list_runs` and `get_run` is `{ micros, currency }`, and a metered figure adds
a required `basis`.

### 3. The rollup store is Postgres, rebuilt from frames after each seal and nightly

`cost.run_totals` is one row per sealed run and `cost.daily_totals` one row
per (workspace, UTC day, level, key) for the five levels operator, agent,
model, tool and task. Both are derived indexes with no source of record in
them: the frames are the record, and both tables can be dropped and rebuilt.

The per-frame source is ClickHouse: `token_usage` rows keyed on the run
(`execution_step_id`) for gateway-metered calls, `tacho_events` `llm_call`
rows for wrapped agents (`packages/telemetry/src/cost-frames.ts`). A ledger
run's tool calls are its `tool.call_completed` events in Postgres; a wrapped
run's are its `tool_call` hook events. The pure rollup
(`packages/billing/src/cost-rollup.ts`) prices every class of every frame at
the entry effective at the frame's instant, keeps the product `units ×
micros_per_million` at full precision, sums the run, and rounds once, half to
even, to whole micros; cents are rounded once more at the statement line and
nowhere earlier (spec §12.3). `cache_hit_rate` is `cache_read ÷
(input_uncached + cache_read)` weighted by each frame's spend, token-weighted
when nothing cost anything, null with no input tokens. A frame the book
prices nothing of, whose record carries no figure, is unpriced; a run or
model group with no priced frame has `cost_micros` and `cost_basis` null
together (a CHECK pairs them). A wrapped run's cache writes are the
`cache_creation_tokens` figure its token-bearing sources carry, priced as 5m
writes, as the ledger branch prices `cache_write_tokens`.

The jobs live in `packages/inngest-functions`: `cost.run-rollup` on
`cost/run.sealed` rebuilds the run's row and then its workspace-day's groups,
with concurrency one per run and retries on a degraded frame store;
`cost.daily-rollup` at 01:00 UTC rolls up every sealed run whose row is
missing or older than its seal (a lost event) and rebuilds the groups of
yesterday for every workspace with a run and of the workspace-day each swept
run started on. The one seal writer in this repository, the tacho ingest
handler, emits `cost/run.sealed` on an `agent_stop` of a root session, after
the batch's frames are appended to ClickHouse, since the job reads them on
receipt and the sweep passes a run whose row postdates its seal; the evidence
ledger's `sealAttempt` has no in-repository caller, so a ledger run's row
arrives with the nightly sweep until a caller exists to emit the event.

The handlers (`packages/handlers/src/spend.*.ts`, `run.cost.ts`,
`cost.price_entry.list.ts`) read Postgres only, through `withTenantDb` with
explicit `org_id` and `workspace_id` predicates beside RLS (the price-book
read names `org_id IS NULL OR org_id = <org>`, the same set the policy
admits). `list_runs` and
`get_run` read `cost` and `basis` from `cost.run_totals` and answer `cost:
null` for a run with no row; they no longer read ClickHouse or the tacho
session's own total.

### 4. The basis vocabulary

`gateway_observed`: the `@oxagen/ai` gateway priced the call.
`client_attested`: the harness that ran the agent reported it.
`mixed`: the figure sums frames observed by both. `estimated`: a frame's
model had no price entry; the frame contributes what its own record reported
(the harness's or the gateway's figure) or the classes the book could price,
and the figure inherits the label. A frame with neither is unpriced and
contributes no figure and no basis. Folding is monotone: equal stays, any
estimate makes the whole an estimate, two different observed bases are
`mixed`. The four values are the CHECK on both tables and the contract enum.
The issue's test list named `estimated_unknown_model` for a run with no price
entry; App. A.7's CHECK and the contract carry `estimated`, and the name is
the same fact.

### 5. The spend-budget gate reads a counter the recorders keep

`billing.spend_counters` holds one row per (org, workspace, UTC day) in
micro-USD. Every recorder that prices a model call adds to it in the same
breath as it writes the frame: `@oxagen/ai` `recordTokenUsage` after
`token_usage`, the tacho ingest handler after a batch that carried cost. The
two writes are independent, each logged and swallowed on failure, so a
ClickHouse stall neither stops the counter nor loses the frame. The gate
(`packages/billing/src/spend-budget-gate.ts`) and `getSpendBudgetStatuses`
sum the counter over the ceiling's window in Postgres; the ClickHouse
`sumSpendMicros` is deleted. The counter is day-granular: a rolling window
that starts mid-day counts the whole of its first day, a bounded over-count
of at most one day's spend at the window's tail; a monthly window is exact.

### 6. What waits, and on what

`verdict`, `accepted` and `productive_ratio` are columns on `run_totals` the
rollup carries through from the existing row and never writes; `proven` and
`accepted` on every figure are null until the proof-witness-verdict and
grading lanes write them, and are never folded together. `list_waste` costs
the one cause the rollup can cost exactly (a cache written and never read);
the findings lane adds its causes. `export_statement` answers CSV in the
call; the signed PDF and the export job listed on Audit › exports wait on the
audit-exports lane and a signing key. Tool rows carry counts and no money
until a frame prices a tool call.

## Alternatives

- **Keep the in-code card as the only price and derive the basis at read
  time.** Rejected: a customer's negotiated price cannot live in a source
  file, a price change would retroactively reprice every run, and no record
  could name the price it was computed with.
- **Aggregate ClickHouse live on the Spend page.** Rejected: a stalled store
  turns a money figure into a zero (#2820), a live aggregation cannot carry
  the run's verdict or acceptance, and the spec makes the rollup a rebuilt
  index.
- **Keep the gate on the ClickHouse sum with a shorter breaker.** Rejected:
  the failure is the fail-open itself, not its latency; the counter puts the
  gate on the store the recorders already write.
- **A rollup written synchronously in the seal transaction.** Rejected: the
  frames are in ClickHouse, and a seal must not wait on, or fail with, the
  analytics store.

## Consequences

- Every money figure a spend contract answers carries a basis or is null;
  a page can print "not recorded" and never a fabricated zero.
- Cost records name the price entries they were priced with, so a figure is
  traceable to a row with an effective window and a source.
- A run's cost appears on Fleet, Run and Spend within one rollup of its seal
  (minutes for a wrapped agent; the nightly sweep for a ledger run until a
  seal caller emits the event).
- The spend-budget gate no longer depends on ClickHouse; a degraded analytics
  store cannot zero a ceiling.
- `cost.price_entries` must be synced before the first rollup prices a run;
  until then every run is `estimated` from its own reported figures, which is
  the honest answer.
